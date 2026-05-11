/**
 * Benchmark runner — executes tasks via the agent and captures traces.
 *
 * Uses CodingAgent directly (not the CLI subprocess) for full control
 * over tool-call instrumentation and trace capture.
 */

import { execSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CodingAgent,
  Session,
  ToolRegistry,
} from "@sean.holung/minicode-sdk";
import type {
  AgentConfig,
  ModelClient,
  ToolDefinition,
} from "@sean.holung/minicode-sdk";

import type {
  BenchmarkTask,
  BenchmarkTrace,
  CapturedToolCall,
} from "./types.js";
import type { ProjectIndex } from "../indexer/types.js";

const COPY_SKIP_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);

/**
 * Narrow symlinks (relative to the source workspace) injected into the
 * isolated workspace after the bulk copy. Goal: make `tsc --noEmit`
 * resolve types for the post-edit diagnostic, *without* enabling the
 * full test runner.
 *
 * - `node_modules/@types` lets tsc resolve `@types/node` etc. (the
 *   typescript binary itself runs from the source workspace and finds
 *   its lib files relative to its own install location, so we don't
 *   need to symlink it into the temp tree.)
 *
 * We intentionally do NOT symlink `node_modules/.bin` or general deps,
 * so commands like `npm test` fail fast with "tsc: not found" rather
 * than running the full pretest+test suite and burning per-task
 * tool-call budget on infrastructure noise. See benchmarks/RESULTS for
 * the symlink scope conversation.
 */
const SYMLINK_FROM_SOURCE: ReadonlyArray<string> = ["node_modules/@types"];

export interface RunnerOptions {
  /** Model client to use. */
  modelClient: ModelClient;
  /** Base agent config (workspace root will be overridden per task). */
  config: AgentConfig;
  /** Static tool definitions to register. */
  tools?: ToolDefinition[];
  /** Optional factory for building task-specific tools and index metadata. */
  createToolset?: (config: AgentConfig, task: BenchmarkTask) => Promise<BenchmarkToolset>;
  /** Variant label for this run (e.g. "baseline"). */
  variant: string;
  /** Repo root used for resolving task.workspaceRoot overrides. */
  repoRoot?: string;
  /** Whether each task should run in an isolated temp workspace copy. Defaults to true. */
  isolateWorkspace?: boolean;
  /** Optional callback after each task completes. */
  onTaskComplete?: (taskId: string, trace: BenchmarkTrace) => void;
}

export interface BenchmarkToolset {
  tools: ToolDefinition[];
  projectIndex?: ProjectIndex | undefined;
}

function getGitCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const STRUCTURAL_TOOLS = new Set([
  "read_symbol",
  "find_references",
  "get_dependencies",
  "search_code_map",
  "find_path",
]);

function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^a-z0-9-_]+/gi, "-");
}

function resolveSourceWorkspaceRoot(
  task: BenchmarkTask,
  options: RunnerOptions,
): string {
  if (!task.workspaceRoot) {
    return path.resolve(options.config.workspaceRoot);
  }

  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  return path.resolve(repoRoot, task.workspaceRoot);
}

function shouldCopyPath(src: string): boolean {
  const name = path.basename(src);
  return !COPY_SKIP_NAMES.has(name);
}

async function linkSharedDirs(
  sourceRoot: string,
  workspaceRoot: string,
): Promise<void> {
  for (const rel of SYMLINK_FROM_SOURCE) {
    const sourcePath = path.join(sourceRoot, rel);
    try {
      const s = await stat(sourcePath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const linkPath = path.join(workspaceRoot, rel);
    // Ensure parent dir exists — e.g. `node_modules/@types` requires
    // `node_modules/` to be created first (we don't bulk-copy it).
    await mkdir(path.dirname(linkPath), { recursive: true });
    try {
      await symlink(sourcePath, linkPath, "dir");
    } catch {
      // Best-effort: a parent path may not exist or the link target
      // already does. Skip silently — tools that need these resolve
      // to a useful error if missing.
    }
  }
}

async function prepareTaskWorkspace(
  task: BenchmarkTask,
  options: RunnerOptions,
): Promise<{ sourceWorkspaceRoot: string; workspaceRoot: string; cleanup: () => Promise<void> }> {
  const sourceWorkspaceRoot = resolveSourceWorkspaceRoot(task, options);
  if (options.isolateWorkspace === false) {
    return {
      sourceWorkspaceRoot,
      workspaceRoot: sourceWorkspaceRoot,
      cleanup: async () => {},
    };
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "minicode-benchmark-"));
  const isolatedWorkspaceRoot = path.join(tempRoot, sanitizeTaskId(task.id));
  await cp(sourceWorkspaceRoot, isolatedWorkspaceRoot, {
    recursive: true,
    filter: shouldCopyPath,
  });

  await linkSharedDirs(sourceWorkspaceRoot, isolatedWorkspaceRoot);

  return {
    sourceWorkspaceRoot,
    workspaceRoot: isolatedWorkspaceRoot,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function getTrackedSymbolNames(
  toolName: string,
  input: Record<string, unknown>,
): string[] {
  if (toolName === "find_path") {
    const names = [input.from, input.to]
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    return [...new Set(names)];
  }

  // search_code_map uses `pattern`, the other graph tools use one of
  // `name`/`symbol`/`symbolName`/`query`. Without `pattern` in this
  // fallback chain, a search_code_map call would fail to register a
  // queried symbol even when the pattern is the literal symbol name —
  // and any rubric using `expectedSymbols` would then incorrectly fail
  // tasks that were answered correctly via the code-map search.
  //
  // We register the pattern verbatim without resolving it against the
  // project index. The downstream `expectedSymbols` matcher in
  // `evaluator.ts` uses `queried.includes(expected)`, so a too-narrow
  // query (e.g. `"Tool"` against `expectedSymbols: ["ToolRegistry"]`)
  // correctly fails to satisfy the rubric. A too-broad query
  // (`"ToolRegistryFactory"` against `["ToolRegistry"]`) does satisfy
  // it — that asymmetry is intentional and matches how a user-facing
  // search-by-substring is normally interpreted.
  const name =
    input.symbol ??
    input.symbolName ??
    input.name ??
    input.query ??
    input.pattern;
  return typeof name === "string" && name.length > 0 ? [name] : [];
}

function trackStructuralFileReads(
  toolName: string,
  projectIndex: ProjectIndex | undefined,
  input: Record<string, unknown>,
  filesRead: Set<string>,
): void {
  if (!projectIndex || !STRUCTURAL_TOOLS.has(toolName)) {
    return;
  }

  for (const symbolName of getTrackedSymbolNames(toolName, input)) {
    const symbol = projectIndex.getSymbol(symbolName);
    if (symbol) {
      filesRead.add(symbol.filePath);
    }
  }
}

/**
 * Run a single benchmark task and return the captured trace.
 */
export async function runBenchmarkTask(
  task: BenchmarkTask,
  options: RunnerOptions,
): Promise<BenchmarkTrace> {
  const workspace = await prepareTaskWorkspace(task, options);
  const captured: CapturedToolCall[] = [];
  const filesRead = new Set<string>();
  const symbolsQueried = new Set<string>();

  try {
    const taskConfig: AgentConfig = {
      ...options.config,
      workspaceRoot: workspace.workspaceRoot,
    };
    const toolset = options.createToolset
      ? await options.createToolset(taskConfig, task)
      : { tools: options.tools ?? [] };

    // Wrap each tool to capture calls
    const instrumentedTools: ToolDefinition[] = toolset.tools.map((tool) => ({
      ...tool,
      execute: async (input: Record<string, unknown>) => {
        const start = performance.now();
        const output = await tool.execute(input);
        const durationMs = performance.now() - start;

        captured.push({
          name: tool.name,
          input,
          output:
            output.length > 2000 ? output.slice(0, 2000) + "…[truncated]" : output,
          durationMs,
        });

        if (tool.name === "read_file") {
          const filePath = input.path ?? input.file_path ?? input.filePath;
          if (typeof filePath === "string") {
            filesRead.add(filePath);
          }
        }

        trackStructuralFileReads(tool.name, toolset.projectIndex, input, filesRead);

        if (STRUCTURAL_TOOLS.has(tool.name)) {
          for (const symbolName of getTrackedSymbolNames(tool.name, input)) {
            symbolsQueried.add(symbolName);
          }
        }

        return output;
      },
    }));

    const registry = new ToolRegistry(instrumentedTools);
    const session = new Session();

    const agent = new CodingAgent({
      config: taskConfig,
      modelClient: options.modelClient,
      toolRegistry: registry,
      session,
    });

    const startedAt = new Date().toISOString();
    const start = performance.now();

    const { text, usage } = await agent.runTurn(task.prompt);

    const durationMs = performance.now() - start;

    const trace: BenchmarkTrace = {
      taskId: task.id,
      model: taskConfig.model,
      variant: options.variant,
      commitSha: getGitCommitSha(),
      sourceWorkspaceRoot: workspace.sourceWorkspaceRoot,
      workspaceRoot: workspace.workspaceRoot,
      response: text,
      toolCalls: captured,
      filesRead: [...filesRead],
      symbolsQueried: [...symbolsQueried],
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
      },
      durationMs,
      startedAt,
    };

    options.onTaskComplete?.(task.id, trace);
    return trace;
  } finally {
    await workspace.cleanup();
  }
}

/**
 * Run all provided benchmark tasks sequentially.
 */
export async function runBenchmarkSuite(
  tasks: BenchmarkTask[],
  options: RunnerOptions,
): Promise<BenchmarkTrace[]> {
  const traces: BenchmarkTrace[] = [];

  for (const task of tasks) {
    const trace = await runBenchmarkTask(task, options);
    traces.push(trace);
  }

  return traces;
}
