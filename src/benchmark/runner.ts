/**
 * Benchmark runner — executes tasks via the agent and captures traces.
 *
 * Uses CodingAgent directly (not the CLI subprocess) for full control
 * over tool-call instrumentation and trace capture.
 */

import { execSync } from "node:child_process";

import {
  CodingAgent,
  Session,
  ToolRegistry,
} from "@minicode/agent-sdk";
import type {
  AgentConfig,
  ModelClient,
  ToolDefinition,
} from "@minicode/agent-sdk";

import type {
  BenchmarkTask,
  BenchmarkTrace,
  CapturedToolCall,
} from "./types.js";

export interface RunnerOptions {
  /** Model client to use. */
  modelClient: ModelClient;
  /** Base agent config (workspace root will be overridden per task). */
  config: AgentConfig;
  /** Tool definitions to register. */
  tools: ToolDefinition[];
  /** Variant label for this run (e.g. "baseline"). */
  variant: string;
  /** Optional callback after each task completes. */
  onTaskComplete?: (taskId: string, trace: BenchmarkTrace) => void;
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
]);

/**
 * Run a single benchmark task and return the captured trace.
 */
export async function runBenchmarkTask(
  task: BenchmarkTask,
  options: RunnerOptions,
): Promise<BenchmarkTrace> {
  const captured: CapturedToolCall[] = [];
  const filesRead = new Set<string>();
  const symbolsQueried = new Set<string>();

  // Wrap each tool to capture calls
  const instrumentedTools: ToolDefinition[] = options.tools.map((tool) => ({
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

      // Track files read
      if (tool.name === "read_file" || tool.name === "read_symbol") {
        const filePath = input.path ?? input.file_path ?? input.filePath;
        if (typeof filePath === "string") filesRead.add(filePath);
      }

      // Track symbol queries
      if (STRUCTURAL_TOOLS.has(tool.name)) {
        const sym =
          input.symbol ?? input.symbolName ?? input.name ?? input.query;
        if (typeof sym === "string") symbolsQueried.add(sym);
      }

      return output;
    },
  }));

  const registry = new ToolRegistry(instrumentedTools);
  const session = new Session();

  const agent = new CodingAgent({
    config: options.config,
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
    model: options.config.model,
    variant: options.variant,
    commitSha: getGitCommitSha(),
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
