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
 *   MODEL_PROVIDER, MODEL, OPENAI_BASE_URL, OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY
 *   — benchmark-layer overrides for benchmarks/benchmark.config.json.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { writeFile } from "node:fs/promises";

import {
  createModelClient,
} from "@minicode/agent-sdk";
import type { AgentConfig } from "@minicode/agent-sdk";
import { parse as parseDotenv } from "dotenv";

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

interface BenchmarkConfigFile {
  modelProvider?: "anthropic" | "openai-compatible" | undefined;
  model?: string | undefined;
  openAiBaseUrl?: string | undefined;
  maxSteps?: number | undefined;
  maxTokens?: number | undefined;
  maxContextTokens?: number | undefined;
  commandTimeoutMs?: number | undefined;
  maxFileSizeBytes?: number | undefined;
  keepRecentMessages?: number | undefined;
  loopDetectionWindow?: number | undefined;
  maxToolOutputChars?: number | undefined;
}

export interface BuildBenchmarkConfigOptions {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeEnvPath?: string;
  configPath?: string;
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

export function getBenchmarkConfigPath(repoRoot = process.cwd()): string {
  return path.resolve(repoRoot, "benchmarks", "benchmark.config.json");
}

function loadJsonConfigFile<T>(configPath: string): Partial<T> {
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as Partial<T>;
}

function loadHomeEnvVars(homeEnvPath: string): Record<string, string> {
  if (!existsSync(homeEnvPath)) {
    return {};
  }
  return parseDotenv(readFileSync(homeEnvPath, "utf8"));
}

function firstDefined(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value != null && value.length > 0);
}

function getNumberSetting(
  envValue: string | undefined,
  fileValue: number | undefined,
  fallback: number,
): number {
  if (envValue != null && envValue.length > 0) {
    return Number(envValue);
  }
  return fileValue ?? fallback;
}

export function buildConfig(options: BuildBenchmarkConfigOptions = {}): AgentConfig {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const homeEnvPath = options.homeEnvPath ?? path.join(homedir(), ".minicode", ".env");
  const configPath = options.configPath ?? getBenchmarkConfigPath(repoRoot);
  const fileConfig = loadJsonConfigFile<BenchmarkConfigFile>(configPath);
  const homeEnv = loadHomeEnvVars(homeEnvPath);

  const getShellOverride = (key: string): string | undefined => env[key];
  const getSecret = (key: string): string | undefined => firstDefined(env[key], homeEnv[key]);

  const provider = (firstDefined(
    getShellOverride("MODEL_PROVIDER"),
    fileConfig.modelProvider,
    "openai-compatible",
  ) ?? "openai-compatible") as "anthropic" | "openai-compatible";
  const model = firstDefined(
    getShellOverride("MODEL"),
    fileConfig.model,
    "test-model",
  ) ?? "test-model";
  const openAiBaseUrl = firstDefined(
    getShellOverride("OPENAI_BASE_URL"),
    fileConfig.openAiBaseUrl,
    "http://localhost:1234/v1",
  ) ?? "http://localhost:1234/v1";
  const openAiApiKey = provider === "openai-compatible"
    ? (openAiBaseUrl.includes("openrouter.ai")
        ? firstDefined(getSecret("OPENROUTER_API_KEY"), getSecret("OPENAI_API_KEY"))
        : getSecret("OPENAI_API_KEY"))
    : undefined;
  return {
    modelProvider: provider,
    model,
    maxSteps: getNumberSetting(getShellOverride("MAX_STEPS"), fileConfig.maxSteps, 50),
    maxTokens: getNumberSetting(getShellOverride("MAX_TOKENS"), fileConfig.maxTokens, 4096),
    maxContextTokens: getNumberSetting(getShellOverride("MAX_CONTEXT_TOKENS"), fileConfig.maxContextTokens, 32000),
    workspaceRoot: repoRoot,
    commandTimeoutMs: getNumberSetting(getShellOverride("COMMAND_TIMEOUT_MS"), fileConfig.commandTimeoutMs, 30000),
    maxFileSizeBytes: getNumberSetting(getShellOverride("MAX_FILE_SIZE_BYTES"), fileConfig.maxFileSizeBytes, 1000000),
    commandDenylist: [],
    confirmDestructive: false,
    keepRecentMessages: getNumberSetting(getShellOverride("KEEP_RECENT_MESSAGES"), fileConfig.keepRecentMessages, 12),
    loopDetectionWindow: getNumberSetting(getShellOverride("LOOP_DETECTION_WINDOW"), fileConfig.loopDetectionWindow, 6),
    maxToolOutputChars: getNumberSetting(getShellOverride("MAX_TOOL_OUTPUT_CHARS"), fileConfig.maxToolOutputChars, 8000),
    openAiBaseUrl,
    ...(openAiApiKey ? { openAiApiKey } : {}),
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
  const repoRoot = process.cwd();
  const config = buildConfig({ repoRoot });
  const tasksDir = path.resolve(repoRoot, "benchmarks", "tasks");

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
    repoRoot,
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
