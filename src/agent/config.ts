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

// Load order: user home (~/.minicode/.env) < project .env < cwd .env
dotenv.config({ path: path.join(MINICODE_HOME, ".env") });
dotenv.config({ path: envPath, override: true });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

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
): Promise<AgentConfig> {
  const homeConfigPath = path.join(MINICODE_HOME, "agent.config.json");
  const workspaceConfigPath = path.resolve(cwd, "agent.config.json");
  const homeConfig = await loadConfigFile(homeConfigPath);
  const workspaceConfig = await loadConfigFile(workspaceConfigPath);
  const fileConfig: AgentConfigFile = { ...homeConfig, ...workspaceConfig };

  const rawWorkspaceRoot =
    process.env.WORKSPACE_ROOT ?? fileConfig.workspaceRoot ?? cwd;
  const workspaceRoot = path.resolve(cwd, rawWorkspaceRoot);

  const commandDenylist = [
    ...DEFAULT_COMMAND_DENYLIST,
    ...parseUserDenylist(fileConfig.commandDenylist),
  ];

  const rawBaseUrl =
    process.env.OPENAI_BASE_URL ??
    fileConfig.openAiBaseUrl ??
    "http://localhost:1234/v1";
  const isOpenRouter = rawBaseUrl.includes("openrouter");
  const openAiApiKey = isOpenRouter
    ? (process.env.OPENROUTER_API_KEY ??
      process.env.OPENAI_API_KEY ??
      fileConfig.openAiApiKey)
    : (process.env.OPENAI_API_KEY ?? fileConfig.openAiApiKey);

  return {
    modelProvider: parseModelProvider(
      process.env.MODEL_PROVIDER ?? fileConfig.modelProvider ?? "openai-compatible",
    ),
    model:
      process.env.MODEL ??
      fileConfig.model ??
      "zai-org/glm-4.7-flash",
    maxSteps: parseNumber(
      process.env.MAX_STEPS,
      fileConfig.maxSteps ?? 50,
    ),
    maxTokens: parseNumber(
      process.env.MAX_TOKENS,
      fileConfig.maxTokens ?? 4096,
    ),
    maxContextTokens: parseNumber(
      process.env.MAX_CONTEXT_TOKENS,
      fileConfig.maxContextTokens ?? 40_000,
    ),
    workspaceRoot,
    commandTimeoutMs: parseNumber(
      process.env.COMMAND_TIMEOUT_MS,
      fileConfig.commandTimeout ?? 30_000,
    ),
    maxFileSizeBytes: parseNumber(
      process.env.MAX_FILE_SIZE_BYTES,
      fileConfig.maxFileSizeBytes ?? 1_000_000,
    ),
    commandDenylist,
    confirmDestructive: parseBoolean(
      process.env.CONFIRM_DESTRUCTIVE,
      fileConfig.confirmDestructive ?? true,
    ),
    keepRecentMessages: parseNumber(
      process.env.KEEP_RECENT_MESSAGES,
      fileConfig.keepRecentMessages ?? 12,
    ),
    loopDetectionWindow: parseNumber(
      process.env.LOOP_DETECTION_WINDOW,
      fileConfig.loopDetectionWindow ?? 6,
    ),
    maxToolOutputChars: parseNumber(
      process.env.MAX_TOOL_OUTPUT_CHARS,
      fileConfig.maxToolOutputChars ?? 8_000,
    ),
    openAiBaseUrl: rawBaseUrl,
    ...(openAiApiKey !== undefined ? { openAiApiKey } : {}),
    enableFileReadDedup: parseBoolean(
      process.env.ENABLE_FILE_READ_DEDUP,
      fileConfig.enableFileReadDedup ?? true,
    ),
    enableAdaptiveKeepRecent: parseBoolean(
      process.env.ENABLE_ADAPTIVE_KEEP_RECENT,
      fileConfig.enableAdaptiveKeepRecent ?? true,
    ),
    enableToolOutputTruncation: parseBoolean(
      process.env.ENABLE_TOOL_OUTPUT_TRUNCATION,
      fileConfig.enableToolOutputTruncation ?? true,
    ),
    compactionThreshold: parseNumber(
      process.env.COMPACTION_THRESHOLD,
      fileConfig.compactionThreshold ?? 0.8,
    ),
    ...(process.env.COMPACTION_MODEL ?? fileConfig.compactionModel
      ? { compactionModel: process.env.COMPACTION_MODEL ?? fileConfig.compactionModel }
      : {}),
    enableDynamicPrompt: parseBoolean(
      process.env.ENABLE_DYNAMIC_PROMPT,
      fileConfig.enableDynamicPrompt ?? true,
    ),
    ...(() => {
      const effort = parseReasoningEffort(
        process.env.REASONING_EFFORT ?? fileConfig.reasoningEffort,
      );
      return effort ? { reasoningEffort: effort } : {};
    })(),
  };
}

