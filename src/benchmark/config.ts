import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

import type { AgentConfig, ReasoningEffort } from "@sean.holung/minicode-sdk";

const DEFAULT_COMMAND_DENYLIST: RegExp[] = [
  /\brm\s+-rf\s+\//i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\binit\s+0\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

const VALID_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);

export interface BenchmarkConfigFile {
  modelProvider?: "anthropic" | "openai-compatible";
  model?: string;
  openAiBaseUrl?: string;
  workspaceRoot?: string;
  maxSteps?: number;
  maxTokens?: number;
  modelTimeoutSeconds?: number;
  maxContextTokens?: number;
  commandTimeoutMs?: number;
  maxFileSizeBytes?: number;
  keepRecentMessages?: number;
  loopDetectionWindow?: number;
  maxToolOutputChars?: number;
  confirmDestructive?: boolean;
  enableFileReadDedup?: boolean;
  enableAdaptiveKeepRecent?: boolean;
  enableToolOutputTruncation?: boolean;
  compactionThreshold?: number;
  compactionModel?: string;
  reasoningEffort?: ReasoningEffort;
  reasoningMaxTokens?: number;
  enableDynamicPrompt?: boolean;
}

export interface BenchmarkAgentConfigOverrides {
  provider?: string;
  model?: string;
  baseUrl?: string;
  workspaceRoot?: string;
}

export interface BenchmarkConfigOptions {
  cwd?: string;
  configPath?: string;
  envFiles?: string[];
  env?: NodeJS.ProcessEnv;
  overrides?: BenchmarkAgentConfigOverrides;
}

export interface ResolvedBenchmarkEnv {
  values: Record<string, string>;
  configPath: string;
  envFiles: string[];
}

function parseNumber(value: string | number | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parseReasoningEffort(value: string | ReasoningEffort | undefined): ReasoningEffort | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase() as ReasoningEffort;
  return VALID_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function parseModelProvider(value: string | undefined): "anthropic" | "openai-compatible" {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "openai-compatible" ||
    normalized === "openai" ||
    normalized === "lmstudio" ||
    normalized === "lm-studio"
  ) {
    return "openai-compatible";
  }
  return "anthropic";
}

function parseCommandDenylistEnv(value: string | undefined): RegExp[] {
  if (!value?.trim()) {
    return [];
  }

  const trimmed = value.trim();
  const toRegexps = (patterns: string[]): RegExp[] => patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern, "i")];
    } catch {
      return [];
    }
  });

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
        return toRegexps(parsed);
      }
    } catch {
      return [];
    }
  }

  return toRegexps(
    trimmed.split(",").map((pattern) => pattern.trim()).filter(Boolean),
  );
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function getDefaultBenchmarkConfigPath(cwd = process.cwd()): string {
  return path.resolve(cwd, "benchmarks", "benchmark.config.json");
}

async function loadBenchmarkConfigFile(configPath: string): Promise<Partial<BenchmarkConfigFile>> {
  const file = await readOptionalFile(configPath);
  if (!file) {
    return {};
  }
  return JSON.parse(file) as Partial<BenchmarkConfigFile>;
}

export async function resolveBenchmarkEnv(
  options: BenchmarkConfigOptions = {},
): Promise<ResolvedBenchmarkEnv> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : getDefaultBenchmarkConfigPath(cwd);
  const envFiles = (options.envFiles ?? []).map((filePath) => path.resolve(cwd, filePath));
  const values: Record<string, string> = {};

  for (const envFile of envFiles) {
    const file = await readFile(envFile, "utf8");
    Object.assign(values, dotenv.parse(file));
  }

  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) {
      values[key] = value;
    }
  }

  return {
    values,
    configPath,
    envFiles,
  };
}

export async function buildBenchmarkAgentConfig(
  options: BenchmarkConfigOptions = {},
): Promise<AgentConfig> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const resolvedEnv = await resolveBenchmarkEnv(options);
  const fileConfig = await loadBenchmarkConfigFile(resolvedEnv.configPath);
  const overrides = options.overrides ?? {};

  const provider = parseModelProvider(
    overrides.provider ??
    resolvedEnv.values.MODEL_PROVIDER ??
    fileConfig.modelProvider ??
    "openai-compatible",
  );
  const openAiBaseUrl =
    overrides.baseUrl ??
    resolvedEnv.values.OPENAI_BASE_URL ??
    fileConfig.openAiBaseUrl ??
    "http://localhost:1234/v1";
  const model =
    overrides.model ??
    resolvedEnv.values.MODEL ??
    fileConfig.model ??
    "";
  const rawWorkspaceRoot =
    overrides.workspaceRoot ??
    resolvedEnv.values.WORKSPACE_ROOT ??
    fileConfig.workspaceRoot ??
    cwd;
  const workspaceRoot = path.resolve(cwd, rawWorkspaceRoot);
  const isOpenRouter =
    provider === "openai-compatible" &&
    openAiBaseUrl.toLowerCase().includes("openrouter");
  const openAiApiKey = provider === "openai-compatible"
    ? (isOpenRouter
        ? (resolvedEnv.values.OPENROUTER_API_KEY ?? resolvedEnv.values.OPENAI_API_KEY)
        : resolvedEnv.values.OPENAI_API_KEY)
    : undefined;

  return {
    modelProvider: provider,
    model,
    maxSteps: parseNumber(
      resolvedEnv.values.MAX_STEPS ?? fileConfig.maxSteps,
      50,
    ),
    maxTokens: parseNumber(
      resolvedEnv.values.MAX_TOKENS ?? fileConfig.maxTokens,
      16000,
    ),
    modelTimeoutSeconds: parseNumber(
      resolvedEnv.values.MODEL_TIMEOUT_SECONDS ?? fileConfig.modelTimeoutSeconds,
      60,
    ),
    maxContextTokens: parseNumber(
      resolvedEnv.values.MAX_CONTEXT_TOKENS ?? fileConfig.maxContextTokens,
      32_000,
    ),
    workspaceRoot,
    commandTimeoutMs: parseNumber(
      resolvedEnv.values.COMMAND_TIMEOUT_MS ?? fileConfig.commandTimeoutMs,
      30_000,
    ),
    maxFileSizeBytes: parseNumber(
      resolvedEnv.values.MAX_FILE_SIZE_BYTES ?? fileConfig.maxFileSizeBytes,
      1_000_000,
    ),
    commandDenylist: [
      ...DEFAULT_COMMAND_DENYLIST,
      ...parseCommandDenylistEnv(resolvedEnv.values.COMMAND_DENYLIST),
    ],
    confirmDestructive: parseBoolean(
      resolvedEnv.values.CONFIRM_DESTRUCTIVE ?? fileConfig.confirmDestructive,
      false,
    ),
    keepRecentMessages: parseNumber(
      resolvedEnv.values.KEEP_RECENT_MESSAGES ?? fileConfig.keepRecentMessages,
      12,
    ),
    loopDetectionWindow: parseNumber(
      resolvedEnv.values.LOOP_DETECTION_WINDOW ?? fileConfig.loopDetectionWindow,
      6,
    ),
    maxToolOutputChars: parseNumber(
      resolvedEnv.values.MAX_TOOL_OUTPUT_CHARS ?? fileConfig.maxToolOutputChars,
      8_000,
    ),
    openAiBaseUrl,
    ...(openAiApiKey !== undefined ? { openAiApiKey } : {}),
    enableFileReadDedup: parseBoolean(
      resolvedEnv.values.ENABLE_FILE_READ_DEDUP ?? fileConfig.enableFileReadDedup,
      true,
    ),
    enableAdaptiveKeepRecent: parseBoolean(
      resolvedEnv.values.ENABLE_ADAPTIVE_KEEP_RECENT ?? fileConfig.enableAdaptiveKeepRecent,
      true,
    ),
    enableToolOutputTruncation: parseBoolean(
      resolvedEnv.values.ENABLE_TOOL_OUTPUT_TRUNCATION ?? fileConfig.enableToolOutputTruncation,
      true,
    ),
    compactionThreshold: parseNumber(
      resolvedEnv.values.COMPACTION_THRESHOLD ?? fileConfig.compactionThreshold,
      0.8,
    ),
    ...(resolvedEnv.values.COMPACTION_MODEL ?? fileConfig.compactionModel
      ? {
          compactionModel:
            resolvedEnv.values.COMPACTION_MODEL ?? fileConfig.compactionModel ?? "",
        }
      : {}),
    ...(() => {
      const effort = parseReasoningEffort(
        resolvedEnv.values.REASONING_EFFORT ?? fileConfig.reasoningEffort,
      );
      return effort ? { reasoningEffort: effort } : {};
    })(),
    ...(() => {
      // Opt-in hard cap on reasoning tokens per turn. Useful for models
      // (notably Gemini 2.5 Pro) that can otherwise burn the full output
      // budget on dynamic thinking without producing a visible response.
      // Unset by default — uncapped reasoning is the right behavior for
      // most models.
      const raw =
        resolvedEnv.values.REASONING_MAX_TOKENS ?? fileConfig.reasoningMaxTokens;
      if (raw === undefined || raw === null || raw === "") return {};
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value) || value <= 0) return {};
      return { reasoningMaxTokens: Math.floor(value) };
    })(),
    enableDynamicPrompt: parseBoolean(
      resolvedEnv.values.ENABLE_DYNAMIC_PROMPT ?? fileConfig.enableDynamicPrompt,
      false,
    ),
  };
}
