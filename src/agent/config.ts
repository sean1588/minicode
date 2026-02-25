import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import type { AgentConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = __dirname.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(__dirname, "../../../.env")
  : path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });
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

interface AgentConfigFile {
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

async function loadConfigFile(configPath: string): Promise<AgentConfigFile> {
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
  const configPath = path.resolve(cwd, "agent.config.json");
  const fileConfig = await loadConfigFile(configPath);

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
      process.env.MODEL_PROVIDER ?? fileConfig.modelProvider,
    ),
    model:
      process.env.MODEL ??
      fileConfig.model ??
      "claude-sonnet-4-20250514",
    maxSteps: parseNumber(
      process.env.MAX_STEPS,
      fileConfig.maxSteps ?? 25,
    ),
    maxTokens: parseNumber(
      process.env.MAX_TOKENS,
      fileConfig.maxTokens ?? 4096,
    ),
    maxContextTokens: parseNumber(
      process.env.MAX_CONTEXT_TOKENS,
      fileConfig.maxContextTokens ?? 120_000,
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
      fileConfig.confirmDestructive ?? false,
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
      fileConfig.maxToolOutputChars ?? 15_000,
    ),
    openAiBaseUrl: rawBaseUrl,
    ...(openAiApiKey !== undefined ? { openAiApiKey } : {}),
  };
}

