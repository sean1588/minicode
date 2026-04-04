import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import type { AgentConfig, ReasoningEffort } from "@minicode/agent-sdk";

/** User-level config directory: ~/.minicode */
export const MINICODE_HOME = path.join(os.homedir(), ".minicode");

/**
 * Format the current agent configuration for display (e.g. /config slash command).
 */
export function formatConfigForDisplay(config: AgentConfig): string {
  const lines: string[] = [
    "configHome: " + MINICODE_HOME + " (.env, agent.config.json)",
    "workspaceRoot: " + config.workspaceRoot,
    "modelProvider: " + config.modelProvider,
    "model: " + config.model,
    "maxSteps: " + config.maxSteps,
    "maxTokens: " + config.maxTokens,
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
    "enableFileReadDedup: " + (config.enableFileReadDedup ?? false),
    "enableAdaptiveKeepRecent: " + (config.enableAdaptiveKeepRecent ?? false),
    "enableToolOutputTruncation: " + (config.enableToolOutputTruncation ?? false),
    "compactionThreshold: " + (config.compactionThreshold ?? "(disabled)"),
    "compactionModel: " + (config.compactionModel ?? "(disabled — using mechanical compaction)"),
    "reasoningEffort: " + (config.reasoningEffort ?? "(unset — no reasoning parameters sent)"),
    "enableDynamicPrompt: " + (config.enableDynamicPrompt ?? true),
  ];
  return lines.join("\n");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../../../.env")
  : path.resolve(__dirname, "../../.env");

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

export interface AgentConfigFile {
  modelProvider?: string;
  model?: string;
  maxSteps?: number;
  maxTokens?: number;
  maxContextTokens?: number;
  workspaceRoot?: string;
  commandTimeout?: number;
  commandDenylist?: string[];
  confirmDestructive?: boolean;
  maxFileSizeBytes?: number;
  keepRecentMessages?: number;
  loopDetectionWindow?: number;
  maxToolOutputChars?: number;
  openAiBaseUrl?: string;
  openAiApiKey?: string;
  enableFileReadDedup?: boolean;
  enableAdaptiveKeepRecent?: boolean;
  enableToolOutputTruncation?: boolean;
  compactionThreshold?: number;
  compactionModel?: string;
  reasoningEffort?: string;
  enableDynamicPrompt?: boolean;
}

export interface LoadAgentConfigOptions {
  includeWorkspaceConfig?: boolean;
  minicodeHome?: string;
  includeWorkspaceEnv?: boolean;
}

export type ConfigEnvSource =
  | "process"
  | "home-dotenv"
  | "project-dotenv"
  | "cwd-dotenv";

export interface ResolvedConfigEnv {
  values: Record<string, string>;
  sources: Record<string, ConfigEnvSource>;
  homeEnvPath: string;
  projectEnvPath: string;
  cwdEnvPath: string;
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

export async function loadConfigFile(configPath: string): Promise<AgentConfigFile> {
  try {
    await access(configPath);
  } catch {
    return {};
  }

  const file = await readFile(configPath, "utf8");
  const parsed = JSON.parse(file) as unknown;
  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  return parsed as AgentConfigFile;
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
  cwd = process.cwd(),
  options: LoadAgentConfigOptions = {},
): Promise<ResolvedConfigEnv> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const includeWorkspaceEnv = options.includeWorkspaceEnv ?? true;
  const homeEnvPath = path.join(minicodeHome, ".env");
  const projectEnvPath = envPath;
  const cwdEnvPath = path.resolve(cwd, ".env");

  const values: Record<string, string> = {};
  const sources: Record<string, ConfigEnvSource> = {};

  if (includeWorkspaceEnv) {
    applyProcessEnv(values, sources);
    applyEnvLayer(values, sources, await loadDotenvFile(homeEnvPath), "home-dotenv", false);
    applyEnvLayer(values, sources, await loadDotenvFile(projectEnvPath), "project-dotenv", true);
    applyEnvLayer(values, sources, await loadDotenvFile(cwdEnvPath), "cwd-dotenv", true);
  } else {
    applyEnvLayer(values, sources, await loadDotenvFile(homeEnvPath), "home-dotenv", true);
    applyProcessEnv(values, sources);
  }

  return {
    values,
    sources,
    homeEnvPath,
    projectEnvPath,
    cwdEnvPath,
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

export async function loadAgentConfig(
  cwd = process.cwd(),
  options: LoadAgentConfigOptions = {},
): Promise<AgentConfig> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const includeWorkspaceConfig = options.includeWorkspaceConfig ?? true;
  const includeWorkspaceEnv = options.includeWorkspaceEnv ?? true;
  const homeConfigPath = path.join(minicodeHome, "agent.config.json");
  const workspaceConfigPath = path.resolve(cwd, "agent.config.json");
  const homeConfig = await loadConfigFile(homeConfigPath);
  const workspaceConfig = includeWorkspaceConfig
    ? await loadConfigFile(workspaceConfigPath)
    : {};
  const fileConfig: AgentConfigFile = { ...homeConfig, ...workspaceConfig };
  const env = (await resolveConfigEnv(cwd, { minicodeHome, includeWorkspaceEnv })).values;

  const rawWorkspaceRoot =
    env.WORKSPACE_ROOT ?? fileConfig.workspaceRoot ?? cwd;
  const workspaceRoot = path.resolve(cwd, rawWorkspaceRoot);

  const commandDenylist = [
    ...DEFAULT_COMMAND_DENYLIST,
    ...parseUserDenylist(fileConfig.commandDenylist),
  ];

  const rawBaseUrl =
    env.OPENAI_BASE_URL ??
    fileConfig.openAiBaseUrl ??
    "http://localhost:1234/v1";
  const isOpenRouter = rawBaseUrl.includes("openrouter");
  const openAiApiKey = isOpenRouter
    ? (env.OPENROUTER_API_KEY ??
      env.OPENAI_API_KEY ??
      fileConfig.openAiApiKey)
    : (env.OPENAI_API_KEY ?? fileConfig.openAiApiKey);

  return {
    modelProvider: parseModelProvider(
      env.MODEL_PROVIDER ?? fileConfig.modelProvider ?? "openai-compatible",
    ),
    model:
      env.MODEL ??
      fileConfig.model ??
      "zai-org/glm-4.7-flash",
    maxSteps: parseNumber(
      env.MAX_STEPS,
      fileConfig.maxSteps ?? 50,
    ),
    maxTokens: parseNumber(
      env.MAX_TOKENS,
      fileConfig.maxTokens ?? 4096,
    ),
    maxContextTokens: parseNumber(
      env.MAX_CONTEXT_TOKENS,
      fileConfig.maxContextTokens ?? 32_000,
    ),
    workspaceRoot,
    commandTimeoutMs: parseNumber(
      env.COMMAND_TIMEOUT_MS,
      fileConfig.commandTimeout ?? 30_000,
    ),
    maxFileSizeBytes: parseNumber(
      env.MAX_FILE_SIZE_BYTES,
      fileConfig.maxFileSizeBytes ?? 1_000_000,
    ),
    commandDenylist,
    confirmDestructive: parseBoolean(
      env.CONFIRM_DESTRUCTIVE,
      fileConfig.confirmDestructive ?? true,
    ),
    keepRecentMessages: parseNumber(
      env.KEEP_RECENT_MESSAGES,
      fileConfig.keepRecentMessages ?? 12,
    ),
    loopDetectionWindow: parseNumber(
      env.LOOP_DETECTION_WINDOW,
      fileConfig.loopDetectionWindow ?? 6,
    ),
    maxToolOutputChars: parseNumber(
      env.MAX_TOOL_OUTPUT_CHARS,
      fileConfig.maxToolOutputChars ?? 8_000,
    ),
    openAiBaseUrl: rawBaseUrl,
    ...(openAiApiKey !== undefined ? { openAiApiKey } : {}),
    enableFileReadDedup: parseBoolean(
      env.ENABLE_FILE_READ_DEDUP,
      fileConfig.enableFileReadDedup ?? true,
    ),
    enableAdaptiveKeepRecent: parseBoolean(
      env.ENABLE_ADAPTIVE_KEEP_RECENT,
      fileConfig.enableAdaptiveKeepRecent ?? true,
    ),
    enableToolOutputTruncation: parseBoolean(
      env.ENABLE_TOOL_OUTPUT_TRUNCATION,
      fileConfig.enableToolOutputTruncation ?? true,
    ),
    compactionThreshold: parseNumber(
      env.COMPACTION_THRESHOLD,
      fileConfig.compactionThreshold ?? 0.8,
    ),
    ...(env.COMPACTION_MODEL ?? fileConfig.compactionModel
      ? { compactionModel: env.COMPACTION_MODEL ?? fileConfig.compactionModel }
      : {}),
    enableDynamicPrompt: parseBoolean(
      env.ENABLE_DYNAMIC_PROMPT,
      fileConfig.enableDynamicPrompt ?? true,
    ),
    ...(() => {
      const effort = parseReasoningEffort(
        env.REASONING_EFFORT ?? fileConfig.reasoningEffort,
      );
      return effort ? { reasoningEffort: effort } : {};
    })(),
  };
}

