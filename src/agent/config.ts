import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";

import type { AgentConfig, ReasoningEffort } from "@sean.holung/minicode-sdk";

/** User-level config directory: ~/.minicode */
export const MINICODE_HOME = path.join(os.homedir(), ".minicode");

/**
 * Format the current agent configuration for display (e.g. /config slash command).
 */
export function formatConfigForDisplay(config: AgentConfig): string {
  const lines: string[] = [
    "configHome: " + MINICODE_HOME + " (.env)",
    "workspaceRoot: " + config.workspaceRoot,
    "modelProvider: " + config.modelProvider,
    "model: " + config.model,
    "maxSteps: " + config.maxSteps,
    "maxTokens: " + config.maxTokens,
    "modelTimeoutSeconds: " + config.modelTimeoutSeconds,
    "maxContextTokens: " + config.maxContextTokens,
    "commandTimeoutMs: " + config.commandTimeoutMs,
    "maxFileSizeBytes: " + config.maxFileSizeBytes,
    "maxToolOutputChars: " + config.maxToolOutputChars,
    "keepRecentMessages: " + config.keepRecentMessages,
    "loopDetectionWindow: " + config.loopDetectionWindow,
    "confirmDestructive: " + config.confirmDestructive,
    "commandDenylist: " + config.commandDenylist.length + " patterns",
    "openAiBaseUrl: " + config.openAiBaseUrl,
    "openAiApiKey: " + (config.openAiApiKey ? "***" : "(unset)"),
    "anthropicApiKey: " + (config.anthropicApiKey ? "***" : "(unset)"),
    "enableFileReadDedup: " + (config.enableFileReadDedup ?? false),
    "enableAdaptiveKeepRecent: " + (config.enableAdaptiveKeepRecent ?? false),
    "enableToolOutputTruncation: " + (config.enableToolOutputTruncation ?? false),
    "compactionThreshold: " + (config.compactionThreshold ?? "(disabled)"),
    "compactionModel: " + (config.compactionModel ?? "(disabled — using mechanical compaction)"),
    "reasoningEffort: " + (config.reasoningEffort ?? "(unset — no reasoning parameters sent)"),
    "reasoningMaxTokens: " + (config.reasoningMaxTokens !== undefined ? String(config.reasoningMaxTokens) : "(unset — uncapped)"),
    "enableDynamicPrompt: " + (config.enableDynamicPrompt ?? false),
  ];
  return lines.join("\n");
}

/**
 * Check if the config has enough information to connect to a model provider.
 * Returns null if valid, or a user-facing setup message if not.
 */
/**
 * Return a list of missing config items that prevent the agent from running.
 * Empty array means the config is valid.
 */
export function getConfigMissing(config: AgentConfig): string[] {
  const missing: string[] = [];
  const isOpenRouter =
    config.modelProvider === "openai-compatible" &&
    config.openAiBaseUrl.includes("openrouter");

  if (!config.model) {
    missing.push("MODEL is not set");
  }

  if (isOpenRouter && !config.openAiApiKey?.trim()) {
    missing.push("OPENROUTER_API_KEY is not set");
  }

  if (
    config.modelProvider === "anthropic" &&
    !config.anthropicApiKey?.trim() &&
    !process.env.ANTHROPIC_API_KEY?.trim()
  ) {
    missing.push("ANTHROPIC_API_KEY is not set");
  }

  return missing;
}

export type ConfiguredProvider = "anthropic" | "openrouter" | "openai-compatible";

function hasExplicitConfigValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function parseExplicitModelProvider(
  value: string | undefined,
): "anthropic" | "openai-compatible" | undefined {
  if (!hasExplicitConfigValue(value)) {
    return undefined;
  }
  return parseModelProvider(value);
}

export function getConfiguredProvider(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): ConfiguredProvider | null {
  const explicitModelProvider = parseExplicitModelProvider(env.MODEL_PROVIDER);

  if (config.modelProvider === "anthropic") {
    return explicitModelProvider === "anthropic" ||
      hasExplicitConfigValue(env.ANTHROPIC_API_KEY) ||
      hasExplicitConfigValue(config.anthropicApiKey)
      ? "anthropic"
      : null;
  }

  const hasExplicitOpenAiCompatibleConfig =
    explicitModelProvider === "openai-compatible" ||
    hasExplicitConfigValue(env.OPENAI_BASE_URL) ||
    hasExplicitConfigValue(env.OPENROUTER_API_KEY);

  if (!hasExplicitOpenAiCompatibleConfig) {
    return null;
  }

  const baseUrl = (env.OPENAI_BASE_URL ?? config.openAiBaseUrl).trim().toLowerCase();
  return baseUrl.includes("openrouter") ? "openrouter" : "openai-compatible";
}

export function getConfigSetupMessage(config: AgentConfig): string | null {
  const missing = getConfigMissing(config);

  if (missing.length === 0) {
    return null;
  }

  return [
    "minicode is not configured yet. Missing:",
    ...missing.map((m) => `  - ${m}`),
    "",
    "Set these in ~/.minicode/.env or as environment variables.",
    "Editable runtime defaults set through the UI or /config are saved back to ~/.minicode/.env.",
    "",
    "Example ~/.minicode/.env for a local model:",
    "  MODEL_PROVIDER=openai-compatible",
    "  OPENAI_BASE_URL=http://localhost:1234/v1",
    "  MODEL=your-model-name",
    "",
    "Example for Anthropic:",
    "  MODEL_PROVIDER=anthropic",
    "  ANTHROPIC_API_KEY=sk-ant-...",
    "  MODEL=claude-sonnet-4-20250514",
  ].join("\n");
}

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
  "xhigh", "high", "medium", "low", "minimal", "none",
]);

function parseReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as ReasoningEffort;
  return VALID_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

export interface LoadAgentConfigOptions {
  minicodeHome?: string;
}

export type ConfigEnvSource =
  | "process"
  | "home-dotenv";

export interface ResolvedConfigEnv {
  values: Record<string, string>;
  sources: Record<string, ConfigEnvSource>;
  homeEnvPath: string;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
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

async function loadDotenvFile(envPath: string): Promise<Record<string, string>> {
  try {
    const file = await readFile(envPath, "utf8");
    return dotenv.parse(file);
  } catch {
    return {};
  }
}

function applyEnvLayer(
  target: Record<string, string>,
  sources: Record<string, ConfigEnvSource>,
  layer: Record<string, string>,
  source: ConfigEnvSource,
  override: boolean,
): void {
  for (const [key, value] of Object.entries(layer)) {
    if (!override && target[key] !== undefined) {
      continue;
    }
    target[key] = value;
    sources[key] = source;
  }
}

function applyProcessEnv(
  target: Record<string, string>,
  sources: Record<string, ConfigEnvSource>,
): void {
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    target[key] = value;
    sources[key] = "process";
  }
}

export async function resolveConfigEnv(
  options: LoadAgentConfigOptions = {},
): Promise<ResolvedConfigEnv> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const homeEnvPath = path.join(minicodeHome, ".env");

  const values: Record<string, string> = {};
  const sources: Record<string, ConfigEnvSource> = {};

  // Base: ~/.minicode/.env
  applyEnvLayer(values, sources, await loadDotenvFile(homeEnvPath), "home-dotenv", true);
  // Override: shell environment variables take precedence
  applyProcessEnv(values, sources);

  return {
    values,
    sources,
    homeEnvPath,
  };
}

function parseUserDenylist(patterns: string[] | undefined): RegExp[] {
  if (!patterns?.length) {
    return [];
  }

  const denylist: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      denylist.push(new RegExp(pattern, "i"));
    } catch {
      // Ignore malformed denylist patterns from user config.
    }
  }
  return denylist;
}

function parseCommandDenylistEnv(value: string | undefined): RegExp[] {
  if (!value?.trim()) {
    return [];
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parseUserDenylist(parsed);
      }
    } catch {
      return [];
    }
  }

  return parseUserDenylist(
    trimmed.split(",").map((pattern) => pattern.trim()).filter(Boolean),
  );
}

function parseModelProvider(
  value: string | undefined,
): "anthropic" | "openai-compatible" {
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

async function ensureMinicodeHome(minicodeHome: string): Promise<void> {
  await mkdir(minicodeHome, { recursive: true });
}

export async function loadAgentConfig(
  cwd = process.cwd(),
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  await ensureMinicodeHome(minicodeHome);
  const env = (await resolveConfigEnv({ minicodeHome })).values;

  const rawWorkspaceRoot = env.WORKSPACE_ROOT ?? cwd;
  const workspaceRoot = path.resolve(cwd, rawWorkspaceRoot);

  const commandDenylist = [
    ...DEFAULT_COMMAND_DENYLIST,
    ...parseCommandDenylistEnv(env.COMMAND_DENYLIST),
  ];

  const rawBaseUrl = env.OPENAI_BASE_URL ?? "http://localhost:1234/v1";
  const isOpenRouter = rawBaseUrl.includes("openrouter");
  const openAiApiKey = isOpenRouter
    ? (env.OPENROUTER_API_KEY ?? env.OPENAI_API_KEY)
    : env.OPENAI_API_KEY;
  const anthropicApiKey = env.ANTHROPIC_API_KEY;

  return {
    modelProvider: parseModelProvider(
      env.MODEL_PROVIDER ?? "openai-compatible",
    ),
    model: env.MODEL ?? "",
    maxSteps: parseNumber(
      env.MAX_STEPS,
      50,
    ),
    maxTokens: parseNumber(
      env.MAX_TOKENS,
      16000,
    ),
    modelTimeoutSeconds: parseNumber(
      env.MODEL_TIMEOUT_SECONDS,
      60,
    ),
    maxContextTokens: parseNumber(
      env.MAX_CONTEXT_TOKENS,
      32_000,
    ),
    workspaceRoot,
    commandTimeoutMs: parseNumber(
      env.COMMAND_TIMEOUT_MS,
      30_000,
    ),
    maxFileSizeBytes: parseNumber(
      env.MAX_FILE_SIZE_BYTES,
      1_000_000,
    ),
    commandDenylist,
    confirmDestructive: parseBoolean(
      env.CONFIRM_DESTRUCTIVE,
      true,
    ),
    keepRecentMessages: parseNumber(
      env.KEEP_RECENT_MESSAGES,
      12,
    ),
    loopDetectionWindow: parseNumber(
      env.LOOP_DETECTION_WINDOW,
      6,
    ),
    maxToolOutputChars: parseNumber(
      env.MAX_TOOL_OUTPUT_CHARS,
      8_000,
    ),
    openAiBaseUrl: rawBaseUrl,
    ...(openAiApiKey !== undefined ? { openAiApiKey } : {}),
    ...(anthropicApiKey !== undefined ? { anthropicApiKey } : {}),
    enableFileReadDedup: parseBoolean(
      env.ENABLE_FILE_READ_DEDUP,
      true,
    ),
    enableAdaptiveKeepRecent: parseBoolean(
      env.ENABLE_ADAPTIVE_KEEP_RECENT,
      true,
    ),
    enableToolOutputTruncation: parseBoolean(
      env.ENABLE_TOOL_OUTPUT_TRUNCATION,
      true,
    ),
    compactionThreshold: parseNumber(
      env.COMPACTION_THRESHOLD,
      0.8,
    ),
    ...(env.COMPACTION_MODEL
      ? { compactionModel: env.COMPACTION_MODEL }
      : {}),
    enableDynamicPrompt: parseBoolean(
      env.ENABLE_DYNAMIC_PROMPT,
      false,
    ),
    ...(() => {
      const effort = parseReasoningEffort(env.REASONING_EFFORT);
      return effort ? { reasoningEffort: effort } : {};
    })(),
    ...(() => {
      const raw = env.REASONING_MAX_TOKENS;
      if (raw === undefined || raw === "") return {};
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) return {};
      return { reasoningMaxTokens: Math.floor(value) };
    })(),
  };
}
