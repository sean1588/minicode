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
  captureBaselineRef,
  collectWorkspaceChanges,
  getWorkspaceDiff,
  writeWorkspaceDiff,
} from "../benchmark/workspace-changes.js";
import { buildProjectIndex } from "../indexer/project-index.js";
import { createToolRegistry } from "../tools/registry.js";
import { CliUsageError } from "./args.js";
import { buildContextBenchTrajectory } from "./contextbench-trajectory.js";

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
  contextBenchTrajectory?: string;
  contextBenchImage?: string;
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
  // Subset of commandTotal: run_command calls whose shell command looks
  // like it mutates the filesystem (heredoc-into-file, sed -i, tee, etc.).
  // Counted separately from mutationTotal so the structured-vs-shell
  // breakdown is preserved.
  shellMutationTotal: number;
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

const BENCHMARK_RETRY_REMINDER_APPROVAL = [
  "Benchmark harness reminder:",
  "- This task is already approved.",
  "- Do not ask for confirmation or present a plan without acting.",
  "- Use tools, make the required edits immediately, and finish the task.",
].join("\n");

// Used when the previous attempt emitted zero tool calls — either pure
// reasoning that produced no output (Gemini 2.5 Pro's thinking-paralysis
// mode) or narration claiming work was done without any tool calls.
// In benchmark mode every task requires code changes; zero tool calls
// is a definite failure regardless of what the response text claims.
const BENCHMARK_RETRY_REMINDER_NO_ACTION = [
  "Benchmark harness reminder:",
  "- Your previous response made zero tool calls. The task is not complete.",
  '- Code changes only happen through tool calls (edit_file / write_file). Text alone — including past-tense statements like "I\'ve added X" or future-tense plans like "I\'ll add X" — is not a change.',
  "- Begin by reading the relevant files with read_file or read_symbol, then make the edits with edit_file / write_file, then verify the result with run_command.",
].join("\n");

// Used when the previous attempt made tool calls but never mutated any
// file (no edit_file/write_file, no `cat > FILE`/`sed -i`/`tee` shell
// edit). Observed shape: model reads a few symbols, narrates a plan
// ("Here's how I'll fix it: 1. … 2. …"), and stops without acting.
// Distinct from `approval_seeking` (no explicit confirmation request)
// and from `no_action` (tool-call count > 0).
const BENCHMARK_RETRY_REMINDER_NO_MUTATION = [
  "Benchmark harness reminder:",
  "- Your previous response read files but never edited any. The task is not complete.",
  "- Code changes only happen through file mutations: edit_file / write_file (preferred), or a shell command that writes to a file (e.g. `cat > path <<EOF`, `sed -i ...`).",
  "- Reading more files is not progress on its own. Identify the file to change, make the edit, then verify with run_command.",
].join("\n");

/**
 * Cap on prior-reasoning content forwarded to the retry prompt. ~2000
 * chars ≈ 500 tokens — enough to convey the model's high-level plan from
 * the failed attempt without ballooning the second attempt's input cost.
 */
const PRIOR_REASONING_MAX_CHARS = 2000;

/**
 * Build a "your previous attempt thought this" block to append to the
 * retry prompt. Helps the model see its own prior reasoning so the
 * retry isn't starting from a cold state — particularly useful when the
 * first attempt collapsed to pure reasoning (no visible content / no
 * tool calls). Returns an empty string when no reasoning was captured.
 */
export function buildPriorReasoningContext(
  reasoningContent: string | undefined,
): string {
  if (typeof reasoningContent !== "string") {
    return "";
  }
  const trimmed = reasoningContent.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const snippet =
    trimmed.length > PRIOR_REASONING_MAX_CHARS
      ? trimmed.slice(0, PRIOR_REASONING_MAX_CHARS) +
        `\n…[${trimmed.length - PRIOR_REASONING_MAX_CHARS} more chars of reasoning truncated]`
      : trimmed;
  return [
    "",
    "Your previous attempt's internal reasoning (verbatim, for your own context):",
    "<<<PRIOR_REASONING>>>",
    snippet,
    "<<<END_PRIOR_REASONING>>>",
    "Apply that reasoning concretely — make the file changes your previous turn was planning, then verify.",
  ].join("\n");
}

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

export type BenchmarkRetryReason = "approval_seeking" | "no_action" | "no_mutation";

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

// Heuristics for "this shell command modified a file." Observed during
// trace analysis: gemini-3-pro routinely uses `cat > FILE <<EOF` /
// `cat >> FILE` heredocs instead of edit_file/write_file, so the model
// is doing real work while our toolUsage.mutationTotal reads zero. The
// retry detector and mutation analysis both need to recognize these as
// real edits.
const SHELL_MUTATION_PATTERNS: RegExp[] = [
  // Redirect to a file: `> path`, `>> path`, or with a leading fd like `2> path`.
  // Excludes `/dev/null`, `/dev/stderr`, and fd redirects (`>&2`).
  /(?:^|[^&>])>>?\s*(?!\/dev\/null\b|\/dev\/stderr\b|&\d)[^\s|;&<>]+/,
  // sed in-place edit.
  /\bsed\b[^|;]*\s-i\b/,
  // tee writes its stdin to one or more files.
  /\btee\b(?!\s+--help\b)/,
  // Python `open(..., "w"|"a"|"r+"|"wb"|"ab").write(...)` invocation (covers
  // the common `python -c "..."` mutation shape).
  /\bopen\s*\(\s*['"][^'"]+['"]\s*,\s*['"][rwa]\+?b?\+?['"]\s*\)\s*\.\s*write\b/,
];

export function looksLikeShellFileMutation(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) {
    return false;
  }
  return SHELL_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

function toolCallLooksLikeShellMutation(toolCall: {
  name: string;
  input: Record<string, unknown>;
}): boolean {
  if (!COMMAND_TOOL_NAMES.has(toolCall.name)) {
    return false;
  }
  const command = toolCall.input?.command;
  return typeof command === "string" && looksLikeShellFileMutation(command);
}

interface BenchmarkAttemptResult {
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  // Most recent step's reasoning content from the model, when the provider
  // exposed it. Used by the retry path to feed the model's own prior
  // thinking back into the retry prompt — "you reasoned X but didn't act,
  // do it now" works much better than abstract scolding.
  reasoningContent?: string;
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

function countToolCallsInMessages(messages: SessionMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      count += message.toolCalls.length;
    }
  }
  return count;
}

/**
 * Count any tool call that produced a real workspace mutation, whether via
 * the structured tools (edit_file / write_file) or via a shell command
 * that looks like a file write (heredoc into a file, sed -i, tee, etc.).
 */
export function countMutationsInMessages(messages: SessionMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      if (MUTATION_TOOL_NAMES.has(toolCall.name)) {
        count += 1;
        continue;
      }
      if (
        toolCallLooksLikeShellMutation({
          name: toolCall.name,
          input: (toolCall.input ?? {}) as Record<string, unknown>,
        })
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/**
 * Decide whether a benchmark attempt should be retried once with an
 * additional reminder appended to the prompt. Returns the reason (so the
 * caller can pick a matching reminder), or `null` if the attempt looks
 * fine as-is.
 *
 * Three failure modes warrant retry, checked in this order:
 *   - `no_action`: the model emitted zero tool calls in the entire turn.
 *     In benchmark mode every task requires code changes, so a tool-call-
 *     free response is by definition incomplete. Covers both pure-
 *     reasoning failures (visible text empty) and hallucinated-completion
 *     narration ("I've added the helper" with no edit_file call).
 *   - `approval_seeking`: the model asked for confirmation rather than
 *     acting, even though it made some tool calls.
 *   - `no_mutation`: the model made tool calls but never produced a file
 *     mutation — read-only exploration that stopped at a plan. Observed
 *     on Gemini 2.5 Pro: 3 read_symbol calls followed by a future-tense
 *     plan, no edit. mutationCount counts both structured and shell-based
 *     mutations so this only fires when the model genuinely did nothing
 *     to the workspace.
 */
export function getBenchmarkRetryReason(attempt: {
  text: string;
  toolCallCount: number;
  mutationCount: number;
}): BenchmarkRetryReason | null {
  if (attempt.toolCallCount === 0) {
    return "no_action";
  }
  if (isBenchmarkApprovalSeekingResponse(attempt.text)) {
    return "approval_seeking";
  }
  if (attempt.mutationCount === 0) {
    return "no_mutation";
  }
  return null;
}

export function getBenchmarkRetryReminder(reason: BenchmarkRetryReason): string {
  switch (reason) {
    case "approval_seeking":
      return BENCHMARK_RETRY_REMINDER_APPROVAL;
    case "no_action":
      return BENCHMARK_RETRY_REMINDER_NO_ACTION;
    case "no_mutation":
      return BENCHMARK_RETRY_REMINDER_NO_MUTATION;
  }
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
  let shellMutationTotal = 0;
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
      if (toolCallLooksLikeShellMutation(toolCall)) {
        shellMutationTotal += 1;
      }
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
    shellMutationTotal,
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
  let contextBenchTrajectory: string | undefined;
  let contextBenchImage: string | undefined;
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
    if (arg === "--contextbench-trajectory") {
      const parsed = readFlagValue(argv, i, "--contextbench-trajectory");
      contextBenchTrajectory = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--contextbench-trajectory=")) {
      contextBenchTrajectory = arg.slice("--contextbench-trajectory=".length).trim();
      continue;
    }
    if (arg === "--contextbench-image") {
      const parsed = readFlagValue(argv, i, "--contextbench-image");
      contextBenchImage = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg.startsWith("--contextbench-image=")) {
      contextBenchImage = arg.slice("--contextbench-image=".length).trim();
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
    ...(contextBenchTrajectory ? { contextBenchTrajectory } : {}),
    ...(contextBenchImage ? { contextBenchImage } : {}),
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

    // Snapshot HEAD before the model runs so we can diff against this point
    // even if it commits its fix mid-run. Without this, `git diff` (which
    // compares working-tree vs index) is blind to committed changes and the
    // patch returned to the harness would be empty.
    const baselineRef = (await captureBaselineRef(config.workspaceRoot)) ?? undefined;

    const startedAt = new Date().toISOString();
    const started = performance.now();
    let attempt = await runBenchmarkAttempt(prompt, {
      config,
      modelClient,
      toolRegistry,
      verbose: args.verbose,
      ...(projectIndex !== undefined ? { projectIndex } : {}),
    });
    const retryReason = getBenchmarkRetryReason({
      text: attempt.text,
      toolCallCount: countToolCallsInMessages(attempt.messages),
      mutationCount: countMutationsInMessages(attempt.messages),
    });
    if (retryReason !== null) {
      if (args.verbose) {
        const description =
          retryReason === "approval_seeking"
            ? "Model asked for confirmation"
            : retryReason === "no_action"
              ? "Model emitted zero tool calls (pure-reasoning or narration-only response)"
              : "Model made tool calls but never mutated any file (plan-only response)";
        console.error(
          `[benchmark] ${description}; retrying once with a non-interactive reminder.`,
        );
      }
      const reminder = getBenchmarkRetryReminder(retryReason);
      const priorReasoningBlock = buildPriorReasoningContext(
        attempt.reasoningContent,
      );
      attempt = await runBenchmarkAttempt(
        `${prompt}\n\n${reminder}${priorReasoningBlock}`,
        {
          config,
          modelClient,
          toolRegistry,
          verbose: args.verbose,
          ...(projectIndex !== undefined ? { projectIndex } : {}),
        },
      );
    }
    const durationMs = performance.now() - started;
    const completedAt = new Date().toISOString();

    const changes = await collectWorkspaceChanges(config.workspaceRoot, baselineRef);
    let diffOutPath: string | undefined;
    if (args.diffOut) {
      diffOutPath = path.resolve(cwd, args.diffOut);
      await writeWorkspaceDiff(config.workspaceRoot, diffOutPath, baselineRef);
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

    if (args.contextBenchTrajectory) {
      const trajectoryPath = path.resolve(cwd, args.contextBenchTrajectory);
      const patch = (await getWorkspaceDiff(config.workspaceRoot, baselineRef)) ?? "";
      const trajectory = buildContextBenchTrajectory({
        systemPrompt: BENCHMARK_SYSTEM_PROMPT_SUFFIX,
        userPrompt: prompt,
        toolCalls,
        finalAssistantText: attempt.text,
        workspaceRoot: config.workspaceRoot,
        patch,
        ...(projectIndex !== undefined ? { projectIndex } : {}),
        ...(args.contextBenchImage ? { image: args.contextBenchImage } : {}),
      });
      await mkdir(path.dirname(trajectoryPath), { recursive: true });
      await writeFile(trajectoryPath, JSON.stringify(trajectory, null, 2) + "\n", "utf8");
    }
  } finally {
    if (previousAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
    }
  }
}
