import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  CodingAgent,
  createModelClient,
  type SessionMessage,
  type ToolCall,
} from "@sean.holung/minicode-sdk";

import { getConfigSetupMessage } from "../agent/config.js";
import {
  buildBenchmarkAgentConfig,
  resolveBenchmarkEnv,
} from "../benchmark/config.js";
import {
  collectWorkspaceChanges,
  writeWorkspaceDiff,
} from "../benchmark/workspace-changes.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { createToolRegistry } from "../tools/registry.js";
import { CliUsageError } from "./args.js";

export interface BenchmarkRunArgs {
  prompt: string;
  promptFile?: string;
  configPath?: string;
  envFiles: string[];
  provider?: string;
  model?: string;
  baseUrl?: string;
  workspaceRoot?: string;
  diffOut?: string;
  outFile?: string;
  verbose: boolean;
}

export interface BenchmarkRunResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  } | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
  workspaceRoot: string;
  provider: "anthropic" | "openai-compatible";
  model: string;
  openAiBaseUrl: string;
  isGitRepo: boolean;
  changedFiles: string[];
  diffOut?: string;
  toolCalls: BenchmarkToolCallTrace[];
  toolUsage: BenchmarkToolUsageSummary;
}

export interface BenchmarkToolCallTrace {
  step: number;
  name: string;
  input: Record<string, unknown>;
  result: string | null;
  skipped: boolean;
}

export interface BenchmarkRepeatedToolCall {
  name: string;
  input: Record<string, unknown>;
  count: number;
}

export interface BenchmarkToolUsageSummary {
  total: number;
  byName: Record<string, number>;
  specializedTotal: number;
  specializedByName: Record<string, number>;
  fileReadTotal: number;
  searchTotal: number;
  mutationTotal: number;
  commandTotal: number;
  skippedTotal: number;
  repeatedStop: boolean;
  repeatedToolCalls: BenchmarkRepeatedToolCall[];
}

const BENCHMARK_SYSTEM_PROMPT_SUFFIX = [
  "[Execution Mode]",
  "- This task is running in a non-interactive harness. The task is already approved.",
  "- Do not ask for confirmation, permission, or whether you should proceed.",
  "- If the task requires code changes, make them immediately using the available tools.",
  "- Do not stop after presenting a plan. Either complete the task or explain a concrete blocker.",
  "",
  "[Long-form Task Discipline]",
  "- Non-trivial coding tasks routinely require 30+ tool-call iterate-test-fix cycles. Persistent iteration against the test suite is expected; do not bail early because you have read a few files.",
  "- Iterate against the canonical test runner (the test command shipped with the task) until it passes. Treat the runner's output as the source of truth — not your own assessment of whether the code looks correct, and not ad-hoc verification scripts you write yourself.",
  "- Before declaring the task complete: run the FULL existing test suite, not just tests targeting the new feature. Many tasks modify code that other features depend on — verify you did not break previously-passing functionality. Regression failures on stages you were not asked to modify still count as failures.",
  "- \"I have implemented X\" is not the same as \"tests pass.\" Do not declare completion without observing an explicit green signal (exit code 0, all-pass marker) from the canonical test runner over the full suite.",
].join("\n");

const BENCHMARK_RETRY_REMINDER = [
  "Benchmark harness reminder:",
  "- This task is already approved.",
  "- Do not ask for confirmation or present a plan without acting.",
  "- Use tools, make the required edits immediately, and finish the task.",
].join("\n");

const CONFIRMATION_REQUEST_PATTERNS = [
  /\bplease confirm\b/i,
  /\bconfirm and i(?:'|’)ll\b/i,
  /\bmay i proceed\b/i,
  /\bshould i proceed\b/i,
  /\bwould you like me to proceed\b/i,
  /\bwant me to proceed\b/i,
  /\bdo you want me to proceed\b/i,
  /\bask for your approval\b/i,
  /\bneed your approval\b/i,
  /\bpermission\b/i,
];

const SPECIALIZED_TOOL_NAMES = new Set([
  "read_symbol",
  "find_references",
  "get_dependencies",
  "search_code_map",
  "find_path",
]);

const FILE_READ_TOOL_NAMES = new Set(["read_file"]);
const SEARCH_TOOL_NAMES = new Set(["search"]);
const MUTATION_TOOL_NAMES = new Set(["edit_file", "write_file"]);
const COMMAND_TOOL_NAMES = new Set(["run_command"]);
const REPEATED_TOOL_CALL_STOP_TEXT = "Stopped due to repeated identical tool calls";

interface BenchmarkAttemptResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  streamed?: boolean;
  messages: SessionMessage[];
}

export function getBenchmarkSystemPromptSuffix(): string {
  return BENCHMARK_SYSTEM_PROMPT_SUFFIX;
}

export function isBenchmarkApprovalSeekingResponse(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return CONFIRMATION_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function signatureForToolCall(toolCall: Pick<ToolCall, "name" | "input">): string {
  return `${toolCall.name}:${stableSerialize(toolCall.input)}`;
}

export function buildBenchmarkToolTrace(messages: SessionMessage[]): BenchmarkToolCallTrace[] {
  const toolResults = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "tool") {
      toolResults.set(message.toolCallId, message.content);
    }
  }

  const traces: BenchmarkToolCallTrace[] = [];
  let step = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    step += 1;
    for (const toolCall of message.toolCalls) {
      const result = toolResults.get(toolCall.id) ?? null;
      traces.push({
        step,
        name: toolCall.name,
        input: toolCall.input,
        result,
        skipped: result?.startsWith("Tool skipped:") ?? false,
      });
    }
  }

  return traces;
}

export function summarizeBenchmarkToolUsage(
  toolCalls: BenchmarkToolCallTrace[],
  finalText: string,
): BenchmarkToolUsageSummary {
  const byName: Record<string, number> = {};
  const specializedByName: Record<string, number> = {};
  const repeatedCounts = new Map<string, {
    name: string;
    input: Record<string, unknown>;
    count: number;
  }>();

  let specializedTotal = 0;
  let fileReadTotal = 0;
  let searchTotal = 0;
  let mutationTotal = 0;
  let commandTotal = 0;
  let skippedTotal = 0;

  for (const toolCall of toolCalls) {
    byName[toolCall.name] = (byName[toolCall.name] ?? 0) + 1;

    if (SPECIALIZED_TOOL_NAMES.has(toolCall.name)) {
      specializedTotal += 1;
      specializedByName[toolCall.name] = (specializedByName[toolCall.name] ?? 0) + 1;
    }
    if (FILE_READ_TOOL_NAMES.has(toolCall.name)) {
      fileReadTotal += 1;
    }
    if (SEARCH_TOOL_NAMES.has(toolCall.name)) {
      searchTotal += 1;
    }
    if (MUTATION_TOOL_NAMES.has(toolCall.name)) {
      mutationTotal += 1;
    }
    if (COMMAND_TOOL_NAMES.has(toolCall.name)) {
      commandTotal += 1;
    }
    if (toolCall.skipped) {
      skippedTotal += 1;
    }

    const signature = signatureForToolCall(toolCall);
    const existing = repeatedCounts.get(signature);
    if (existing) {
      existing.count += 1;
    } else {
      repeatedCounts.set(signature, {
        name: toolCall.name,
        input: toolCall.input,
        count: 1,
      });
    }
  }

  return {
    total: toolCalls.length,
    byName,
    specializedTotal,
    specializedByName,
    fileReadTotal,
    searchTotal,
    mutationTotal,
    commandTotal,
    skippedTotal,
    repeatedStop:
      finalText.includes(REPEATED_TOOL_CALL_STOP_TEXT) ||
      toolCalls.some((toolCall) => toolCall.result?.includes(REPEATED_TOOL_CALL_STOP_TEXT)),
    repeatedToolCalls: [...repeatedCounts.values()]
      .filter((entry) => entry.count > 1)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

function readFlagValue(
  args: string[],
  index: number,
  flagName: string,
): { value: string; nextIndex: number } {
  const next = args[index + 1];
  if (!next || next.startsWith("-")) {
    throw new CliUsageError(`${flagName} requires a value.`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseBenchmarkRunArgs(argv: string[]): BenchmarkRunArgs {
  const envFiles: string[] = [];
  const promptParts: string[] = [];
  let promptFile: string | undefined;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let baseUrl: string | undefined;
  let workspaceRoot: string | undefined;
  let diffOut: string | undefined;
  let outFile: string | undefined;
  let verbose = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }

    if (arg === "--verbose" || arg === "-v") {
      verbose = true;
      continue;
    }
    if (arg === "--config") {
      const parsed = readFlagValue(argv, i, "--config");
      configPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length).trim();
      continue;
    }
    if (arg === "--env-file") {
      const parsed = readFlagValue(argv, i, "--env-file");
      envFiles.push(parsed.value);
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      envFiles.push(arg.slice("--env-file=".length).trim());
      continue;
    }
    if (arg === "--provider") {
      const parsed = readFlagValue(argv, i, "--provider");
      provider = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length).trim();
      continue;
    }
    if (arg === "--model") {
      const parsed = readFlagValue(argv, i, "--model");
      model = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--model=")) {
      model = arg.slice("--model=".length).trim();
      continue;
    }
    if (arg === "--base-url") {
      const parsed = readFlagValue(argv, i, "--base-url");
      baseUrl = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      baseUrl = arg.slice("--base-url=".length).trim();
      continue;
    }
    if (arg === "--workspace-root") {
      const parsed = readFlagValue(argv, i, "--workspace-root");
      workspaceRoot = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--workspace-root=")) {
      workspaceRoot = arg.slice("--workspace-root=".length).trim();
      continue;
    }
    if (arg === "--diff-out") {
      const parsed = readFlagValue(argv, i, "--diff-out");
      diffOut = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--diff-out=")) {
      diffOut = arg.slice("--diff-out=".length).trim();
      continue;
    }
    if (arg === "--out") {
      const parsed = readFlagValue(argv, i, "--out");
      outFile = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--out=")) {
      outFile = arg.slice("--out=".length).trim();
      continue;
    }
    if (arg === "--prompt-file") {
      const parsed = readFlagValue(argv, i, "--prompt-file");
      promptFile = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--prompt-file=")) {
      promptFile = arg.slice("--prompt-file=".length).trim();
      continue;
    }

    promptParts.push(arg);
  }

  if (promptFile && promptParts.length > 0) {
    throw new CliUsageError("Provide either prompt text or --prompt-file, not both.");
  }

  return {
    prompt: promptParts.join(" ").trim(),
    ...(promptFile ? { promptFile } : {}),
    ...(configPath ? { configPath } : {}),
    envFiles,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(diffOut ? { diffOut } : {}),
    ...(outFile ? { outFile } : {}),
    verbose,
  };
}

async function resolvePrompt(args: BenchmarkRunArgs, cwd: string): Promise<string> {
  if (args.promptFile) {
    const promptFilePath = path.resolve(cwd, args.promptFile);
    return (await readFile(promptFilePath, "utf8")).trim();
  }
  return args.prompt;
}

function createBenchmarkAgent(params: {
  config: Awaited<ReturnType<typeof buildBenchmarkAgentConfig>>;
  modelClient: ReturnType<typeof createModelClient>;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  verbose: boolean;
  projectIndex?: Awaited<ReturnType<typeof buildProjectIndex>>;
}): CodingAgent {
  return new CodingAgent({
    config: params.config,
    modelClient: params.modelClient,
    toolRegistry: params.toolRegistry,
    verbose: params.verbose,
    getSystemPromptSuffix: () => getBenchmarkSystemPromptSuffix(),
    ...(params.projectIndex !== undefined
      ? {
          getCodeMap: (focusSymbols?: Set<string>) =>
            params.projectIndex!.getCodeMap(undefined, focusSymbols),
        }
      : {}),
  });
}

async function runBenchmarkAttempt(
  prompt: string,
  params: {
    config: Awaited<ReturnType<typeof buildBenchmarkAgentConfig>>;
    modelClient: ReturnType<typeof createModelClient>;
    toolRegistry: ReturnType<typeof createToolRegistry>;
    verbose: boolean;
    projectIndex?: Awaited<ReturnType<typeof buildProjectIndex>>;
  },
): Promise<BenchmarkAttemptResult> {
  const agent = createBenchmarkAgent(params);
  const result = await agent.runTurn(prompt);
  return {
    ...result,
    messages: agent.getSession().getMessages(),
  };
}

export async function runBenchmarkCommand(argv: string[]): Promise<void> {
  const cwd = process.cwd();
  const args = parseBenchmarkRunArgs(argv);
  const prompt = await resolvePrompt(args, cwd);
  if (prompt.length === 0) {
    throw new CliUsageError(
      "benchmark run requires prompt text or --prompt-file. Example: minicode benchmark run --prompt-file prompt.txt",
    );
  }

  const benchmarkOptions = {
    cwd,
    envFiles: args.envFiles,
    env: process.env,
    ...(args.configPath ? { configPath: args.configPath } : {}),
  };
  const resolvedEnv = await resolveBenchmarkEnv(benchmarkOptions);
  const config = await buildBenchmarkAgentConfig({
    ...benchmarkOptions,
    overrides: {
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      ...(args.workspaceRoot ? { workspaceRoot: args.workspaceRoot } : {}),
    },
  });

  const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (resolvedEnv.values.ANTHROPIC_API_KEY !== undefined) {
    process.env.ANTHROPIC_API_KEY = resolvedEnv.values.ANTHROPIC_API_KEY;
  }

  try {
    const setupMessage = getConfigSetupMessage(config);
    if (setupMessage) {
      throw new CliUsageError(
        `${setupMessage}\n\nBenchmark mode does not read ~/.minicode/.env unless you pass it explicitly with --env-file.`,
      );
    }

    const modelClient = createModelClient(config);
    let projectIndex: Awaited<ReturnType<typeof buildProjectIndex>> | undefined;
    try {
      projectIndex = await buildProjectIndex(config.workspaceRoot);
    } catch {
      projectIndex = undefined;
    }

    const toolRegistry = createToolRegistry(config, projectIndex);

    const startedAt = new Date().toISOString();
    const started = performance.now();
    let attempt = await runBenchmarkAttempt(prompt, {
      config,
      modelClient,
      toolRegistry,
      verbose: args.verbose,
      ...(projectIndex !== undefined ? { projectIndex } : {}),
    });
    if (isBenchmarkApprovalSeekingResponse(attempt.text)) {
      if (args.verbose) {
        console.error(
          "[benchmark] Model asked for confirmation; retrying once with a non-interactive reminder.",
        );
      }
      attempt = await runBenchmarkAttempt(`${prompt}\n\n${BENCHMARK_RETRY_REMINDER}`, {
        config,
        modelClient,
        toolRegistry,
        verbose: args.verbose,
        ...(projectIndex !== undefined ? { projectIndex } : {}),
      });
    }
    const durationMs = performance.now() - started;
    const completedAt = new Date().toISOString();

    const changes = await collectWorkspaceChanges(config.workspaceRoot);
    let diffOutPath: string | undefined;
    if (args.diffOut) {
      diffOutPath = path.resolve(cwd, args.diffOut);
      await writeWorkspaceDiff(config.workspaceRoot, diffOutPath);
    }

    const toolCalls = buildBenchmarkToolTrace(attempt.messages);
    const result: BenchmarkRunResult = {
      text: attempt.text,
      usage: attempt.usage ?? null,
      durationMs,
      startedAt,
      completedAt,
      workspaceRoot: config.workspaceRoot,
      provider: config.modelProvider,
      model: config.model,
      openAiBaseUrl: config.openAiBaseUrl,
      isGitRepo: changes.isGitRepo,
      changedFiles: changes.changedFiles,
      ...(diffOutPath ? { diffOut: diffOutPath } : {}),
      toolCalls,
      toolUsage: summarizeBenchmarkToolUsage(toolCalls, attempt.text),
    };
    const payload = JSON.stringify(result, null, 2);

    if (args.outFile) {
      const outPath = path.resolve(cwd, args.outFile);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, payload + "\n", "utf8");
    } else {
      console.log(payload);
    }
  } finally {
    if (previousAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
  }
}
