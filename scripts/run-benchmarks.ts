#!/usr/bin/env node
/**
 * CLI entry point for running benchmark tasks.
 *
 * Usage:
 *   node --import tsx scripts/run-benchmarks.ts [options]
 *
 * Options:
 *   --category <name>   Run only tasks in the given category
 *   --task <id>         Run a single task by id (e.g. "navigation/find-symbol-definition")
 *   --variant <label>   Variant label for the report (default: "ci")
 *   --out <path>        Write the JSON report to a file
 *
 * Environment:
 *   MODEL_PROVIDER, MODEL, OPENAI_BASE_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY
 *   — same as minicode runtime config.
 */

import path from "node:path";
import { writeFile } from "node:fs/promises";

import {
  createModelClient,
} from "@minicode/agent-sdk";
import type { AgentConfig } from "@minicode/agent-sdk";

import { loadBenchmarkTasks, loadBenchmarkTask } from "../src/benchmark/task-loader.js";
import { runBenchmarkSuite } from "../src/benchmark/runner.js";
import { buildReport, formatReport } from "../src/benchmark/reporter.js";
import type { BenchmarkTask } from "../src/benchmark/types.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createToolRegistry } from "../src/tools/registry.js";

/* ------------------------------------------------------------------ */
/*  CLI argument parsing                                               */
/* ------------------------------------------------------------------ */

export interface BenchmarkCLIArgs {
  category?: string;
  task?: string;
  variant: string;
  out?: string;
}

export function parseArgs(argv: string[]): BenchmarkCLIArgs {
  const args: BenchmarkCLIArgs = { variant: "ci" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--category" && next) {
      args.category = next;
      i++;
    } else if (arg === "--task" && next) {
      args.task = next;
      i++;
    } else if (arg === "--variant" && next) {
      args.variant = next;
      i++;
    } else if (arg === "--out" && next) {
      args.out = next;
      i++;
    }
  }

  return args;
}

/* ------------------------------------------------------------------ */
/*  Config builder                                                     */
/* ------------------------------------------------------------------ */

export function buildConfig(): AgentConfig {
  const provider = (process.env.MODEL_PROVIDER ?? "openai-compatible") as
    "anthropic" | "openai-compatible";
  const model = process.env.MODEL ?? "test-model";

  return {
    modelProvider: provider,
    model,
    maxSteps: Number(process.env.MAX_STEPS ?? "50"),
    maxTokens: Number(process.env.MAX_TOKENS ?? "4096"),
    maxContextTokens: Number(process.env.MAX_CONTEXT_TOKENS ?? "32000"),
    workspaceRoot: process.cwd(),
    commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? "30000"),
    maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? "1000000"),
    commandDenylist: [],
    confirmDestructive: false,
    keepRecentMessages: Number(process.env.KEEP_RECENT_MESSAGES ?? "12"),
    loopDetectionWindow: Number(process.env.LOOP_DETECTION_WINDOW ?? "6"),
    maxToolOutputChars: Number(process.env.MAX_TOOL_OUTPUT_CHARS ?? "8000"),
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "http://localhost:1234/v1",
    ...(process.env.OPENAI_API_KEY ? { openAiApiKey: process.env.OPENAI_API_KEY } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Task loading                                                       */
/* ------------------------------------------------------------------ */

export async function loadTasks(
  tasksDir: string,
  args: BenchmarkCLIArgs,
): Promise<BenchmarkTask[]> {
  if (args.task) {
    const single = await loadBenchmarkTask(tasksDir, args.task);
    if (!single) {
      throw new Error(`Task not found: ${args.task}`);
    }
    return [single];
  }

  let tasks = await loadBenchmarkTasks(tasksDir);

  if (args.category) {
    tasks = tasks.filter((t) => t.category === args.category);
    if (tasks.length === 0) {
      throw new Error(`No tasks found for category: ${args.category}`);
    }
  }

  return tasks;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig();
  const tasksDir = path.resolve(process.cwd(), "benchmarks", "tasks");

  console.log(`Benchmark runner starting...`);
  console.log(`  Provider: ${config.modelProvider}`);
  console.log(`  Model: ${config.model}`);
  console.log(`  Variant: ${args.variant}`);

  const tasks = await loadTasks(tasksDir, args);
  console.log(`  Tasks: ${tasks.length}`);
  console.log("");

  const modelClient = createModelClient(config);

  const traces = await runBenchmarkSuite(tasks, {
    modelClient,
    config,
    variant: args.variant,
    repoRoot: process.cwd(),
    isolateWorkspace: true,
    createToolset: async (taskConfig) => {
      const projectIndex = await buildProjectIndex(taskConfig.workspaceRoot);
      const toolRegistry = createToolRegistry(taskConfig, projectIndex);
      return {
        tools: toolRegistry.getDefinitions(),
        projectIndex,
      };
    },
    onTaskComplete: (taskId, trace) => {
      const dur = (trace.durationMs / 1000).toFixed(1);
      console.log(`  [done] ${taskId} (${dur}s, ${trace.toolCalls.length} tool calls)`);
    },
  });

  const report = buildReport(tasks, traces, args.variant, config.model);
  const formatted = formatReport(report);

  console.log("");
  console.log(formatted);

  if (args.out) {
    const outPath = path.resolve(args.out);
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\nReport written to ${outPath}`);
  }

  // Exit with failure if any task failed
  if (report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

// Only run main when executed directly (not imported for testing)
const isDirectRun = process.argv[1]?.endsWith("run-benchmarks.ts") ||
                    process.argv[1]?.endsWith("run-benchmarks.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Benchmark runner failed:", err);
    process.exitCode = 1;
  });
}
