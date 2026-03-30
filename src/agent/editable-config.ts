import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, ReasoningEffort } from "@minicode/agent-sdk";

import { loadConfigFile, MINICODE_HOME, type AgentConfigFile } from "./config.js";

export type EditableConfigScope = "workspace" | "global";
type EditableConfigValue = string | number | boolean;
type EditableConfigType = "string" | "number" | "boolean" | "enum";

export interface EditableConfigDefinition {
  key: keyof Pick<
    AgentConfig,
    | "modelProvider"
    | "model"
    | "maxSteps"
    | "maxTokens"
    | "maxContextTokens"
    | "commandTimeoutMs"
    | "maxFileSizeBytes"
    | "confirmDestructive"
    | "keepRecentMessages"
    | "loopDetectionWindow"
    | "maxToolOutputChars"
    | "openAiBaseUrl"
    | "enableFileReadDedup"
    | "enableAdaptiveKeepRecent"
    | "enableToolOutputTruncation"
    | "compactionThreshold"
    | "compactionModel"
    | "reasoningEffort"
    | "enableDynamicPrompt"
  >;
  fileKey: keyof AgentConfigFile;
  envVar: string;
  type: EditableConfigType;
  description: string;
  values?: readonly string[];
}

export interface StructuredConfigEntry {
  key: EditableConfigKey;
  type: EditableConfigType;
  description: string;
  envVar: string;
  values?: readonly string[];
  effectiveValue: string | number | boolean | null;
  workspaceValue: string | number | boolean | null;
  globalValue: string | number | boolean | null;
  envValue: string | null;
  overriddenByEnv: boolean;
}

export interface StructuredConfigPayload {
  workspaceConfigPath: string;
  globalConfigPath: string;
  entries: StructuredConfigEntry[];
}

const REASONING_VALUES = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const satisfies readonly ReasoningEffort[];

export const EDITABLE_CONFIG_DEFINITIONS: readonly EditableConfigDefinition[] = [
  {
    key: "modelProvider",
    fileKey: "modelProvider",
    envVar: "MODEL_PROVIDER",
    type: "enum",
    values: ["anthropic", "openai-compatible"],
    description: "Provider backend used to create the model client",
  },
  {
    key: "model",
    fileKey: "model",
    envVar: "MODEL",
    type: "string",
    description: "Default model id for new sessions",
  },
  {
    key: "maxSteps",
    fileKey: "maxSteps",
    envVar: "MAX_STEPS",
    type: "number",
    description: "Maximum agent loop steps per turn",
  },
  {
    key: "maxTokens",
    fileKey: "maxTokens",
    envVar: "MAX_TOKENS",
    type: "number",
    description: "Maximum completion tokens per model response",
  },
  {
    key: "maxContextTokens",
    fileKey: "maxContextTokens",
    envVar: "MAX_CONTEXT_TOKENS",
    type: "number",
    description: "Estimated prompt-context budget before compaction",
  },
  {
    key: "commandTimeoutMs",
    fileKey: "commandTimeout",
    envVar: "COMMAND_TIMEOUT_MS",
    type: "number",
    description: "Shell command timeout in milliseconds",
  },
  {
    key: "maxFileSizeBytes",
    fileKey: "maxFileSizeBytes",
    envVar: "MAX_FILE_SIZE_BYTES",
    type: "number",
    description: "Maximum file size allowed for read/edit tools",
  },
  {
    key: "confirmDestructive",
    fileKey: "confirmDestructive",
    envVar: "CONFIRM_DESTRUCTIVE",
    type: "boolean",
    description: "Whether destructive commands require confirmation",
  },
  {
    key: "keepRecentMessages",
    fileKey: "keepRecentMessages",
    envVar: "KEEP_RECENT_MESSAGES",
    type: "number",
    description: "Recent messages preserved when trimming session history",
  },
  {
    key: "loopDetectionWindow",
    fileKey: "loopDetectionWindow",
    envVar: "LOOP_DETECTION_WINDOW",
    type: "number",
    description: "Window size for repeated-tool-call loop detection",
  },
  {
    key: "maxToolOutputChars",
    fileKey: "maxToolOutputChars",
    envVar: "MAX_TOOL_OUTPUT_CHARS",
    type: "number",
    description: "Maximum tool output retained before truncation",
  },
  {
    key: "openAiBaseUrl",
    fileKey: "openAiBaseUrl",
    envVar: "OPENAI_BASE_URL",
    type: "string",
    description: "Base URL for OpenAI-compatible providers",
  },
  {
    key: "enableFileReadDedup",
    fileKey: "enableFileReadDedup",
    envVar: "ENABLE_FILE_READ_DEDUP",
    type: "boolean",
    description: "Deduplicate repeated file reads in prompt context",
  },
  {
    key: "enableAdaptiveKeepRecent",
    fileKey: "enableAdaptiveKeepRecent",
    envVar: "ENABLE_ADAPTIVE_KEEP_RECENT",
    type: "boolean",
    description: "Adjust recent-message retention based on context pressure",
  },
  {
    key: "enableToolOutputTruncation",
    fileKey: "enableToolOutputTruncation",
    envVar: "ENABLE_TOOL_OUTPUT_TRUNCATION",
    type: "boolean",
    description: "Truncate oversized tool output before storing it in session history",
  },
  {
    key: "compactionThreshold",
    fileKey: "compactionThreshold",
    envVar: "COMPACTION_THRESHOLD",
    type: "number",
    description: "Compaction threshold ratio used before a turn starts",
  },
  {
    key: "compactionModel",
    fileKey: "compactionModel",
    envVar: "COMPACTION_MODEL",
    type: "string",
    description: "Optional model id used for LLM-based compaction",
  },
  {
    key: "reasoningEffort",
    fileKey: "reasoningEffort",
    envVar: "REASONING_EFFORT",
    type: "enum",
    values: REASONING_VALUES,
    description: "Reasoning effort sent to supported model providers",
  },
  {
    key: "enableDynamicPrompt",
    fileKey: "enableDynamicPrompt",
    envVar: "ENABLE_DYNAMIC_PROMPT",
    type: "boolean",
    description: "Toggle project-aware dynamic prompt generation",
  },
] as const;

const definitionByKey = new Map(
  EDITABLE_CONFIG_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export type EditableConfigKey = (typeof EDITABLE_CONFIG_DEFINITIONS)[number]["key"];

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseEditableValue(
  definition: EditableConfigDefinition,
  rawValue: string,
): EditableConfigValue {
  if (definition.type === "number") {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) {
      throw new Error(`Expected a number for "${definition.key}".`);
    }
    return value;
  }

  if (definition.type === "boolean") {
    const value = parseBoolean(rawValue);
    if (value === undefined) {
      throw new Error(`Expected a boolean for "${definition.key}" (true/false, yes/no, on/off).`);
    }
    return value;
  }

  if (definition.type === "enum") {
    const normalized = rawValue.trim().toLowerCase();
    const match = definition.values?.find((value) => value.toLowerCase() === normalized);
    if (!match) {
      throw new Error(`Expected one of: ${definition.values?.join(", ")}`);
    }
    return match;
  }

  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    throw new Error(`Expected a non-empty value for "${definition.key}".`);
  }
  return trimmed;
}

function normalizePersistedValue(value: unknown): string | number | boolean | null {
  if (value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return null;
}

function isEmptyConfigFile(config: AgentConfigFile): boolean {
  return Object.keys(config).length === 0;
}

export function listEditableConfigDefinitions(): readonly EditableConfigDefinition[] {
  return EDITABLE_CONFIG_DEFINITIONS;
}

export function isEditableConfigKey(value: string): value is EditableConfigKey {
  return definitionByKey.has(value as EditableConfigKey);
}

export function getEditableConfigDefinition(key: EditableConfigKey): EditableConfigDefinition {
  const definition = definitionByKey.get(key);
  if (!definition) {
    throw new Error(`Unknown editable config key "${key}".`);
  }
  return definition;
}

export function getEffectiveEditableConfigValue(
  config: AgentConfig,
  key: EditableConfigKey,
): string {
  return formatPersistedConfigValue(config[key]) as string;
}

export function formatPersistedConfigValue(value: unknown): string {
  if (value === undefined) return "(unset)";
  if (value === null) return "(unset)";
  if (typeof value === "string") return value;
  return String(value);
}

export function getConfigPathForScope(
  cwd: string,
  scope: EditableConfigScope,
  minicodeHome = MINICODE_HOME,
): string {
  return scope === "global"
    ? path.join(minicodeHome, "agent.config.json")
    : path.resolve(cwd, "agent.config.json");
}

export async function loadPersistedConfigLayers(
  cwd: string,
  minicodeHome = MINICODE_HOME,
): Promise<{ global: AgentConfigFile; workspace: AgentConfigFile }> {
  const globalPath = getConfigPathForScope(cwd, "global", minicodeHome);
  const workspacePath = getConfigPathForScope(cwd, "workspace", minicodeHome);
  return {
    global: await loadConfigFile(globalPath),
    workspace: await loadConfigFile(workspacePath),
  };
}

export async function buildStructuredConfigPayload(
  config: AgentConfig,
  cwd: string,
  minicodeHome = MINICODE_HOME,
): Promise<StructuredConfigPayload> {
  const paths = {
    workspaceConfigPath: getConfigPathForScope(cwd, "workspace", minicodeHome),
    globalConfigPath: getConfigPathForScope(cwd, "global", minicodeHome),
  };
  const layers = await loadPersistedConfigLayers(cwd, minicodeHome);

  return {
    ...paths,
    entries: EDITABLE_CONFIG_DEFINITIONS.map((definition) => {
      const envValue = process.env[definition.envVar];
      return {
        key: definition.key,
        type: definition.type,
        description: definition.description,
        envVar: definition.envVar,
        ...(definition.values ? { values: definition.values } : {}),
        effectiveValue: normalizePersistedValue(config[definition.key]),
        workspaceValue: normalizePersistedValue(layers.workspace[definition.fileKey]),
        globalValue: normalizePersistedValue(layers.global[definition.fileKey]),
        envValue: envValue ?? null,
        overriddenByEnv: envValue !== undefined,
      };
    }),
  };
}

export async function setPersistedConfigValue(options: {
  cwd: string;
  key: EditableConfigKey;
  rawValue: string;
  scope?: EditableConfigScope;
  minicodeHome?: string;
}): Promise<{ path: string; storedValue: EditableConfigValue }> {
  const scope = options.scope ?? "workspace";
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(options.key);
  const configPath = getConfigPathForScope(options.cwd, scope, minicodeHome);
  const nextFile = await loadConfigFile(configPath);
  const storedValue = parseEditableValue(definition, options.rawValue);

  nextFile[definition.fileKey] = storedValue as never;

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(nextFile, null, 2) + "\n", "utf8");

  return { path: configPath, storedValue };
}

export async function unsetPersistedConfigValue(options: {
  cwd: string;
  key: EditableConfigKey;
  scope?: EditableConfigScope;
  minicodeHome?: string;
}): Promise<{ path: string }> {
  const scope = options.scope ?? "workspace";
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(options.key);
  const configPath = getConfigPathForScope(options.cwd, scope, minicodeHome);
  const nextFile = await loadConfigFile(configPath);

  delete nextFile[definition.fileKey];

  if (isEmptyConfigFile(nextFile)) {
    await rm(configPath, { force: true });
  } else {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(nextFile, null, 2) + "\n", "utf8");
  }

  return { path: configPath };
}

export async function applyPersistedConfigUpdates(options: {
  cwd: string;
  updates: Record<string, string | number | boolean | null>;
  scope?: EditableConfigScope;
  minicodeHome?: string;
}): Promise<{
  path: string;
  saved: Array<{ key: EditableConfigKey; value: string | number | boolean | null }>;
}> {
  const scope = options.scope ?? "workspace";
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const cwd = options.cwd;

  const planned = Object.entries(options.updates).map(([rawKey, value]) => {
    if (!isEditableConfigKey(rawKey)) {
      throw new Error(`Unknown editable config key "${rawKey}".`);
    }
    return { key: rawKey, value };
  });

  const saved: Array<{ key: EditableConfigKey; value: string | number | boolean | null }> = [];
  for (const item of planned) {
    if (item.value === null) {
      await unsetPersistedConfigValue({
        cwd,
        key: item.key,
        scope,
        minicodeHome,
      });
      saved.push({ key: item.key, value: null });
      continue;
    }

    await setPersistedConfigValue({
      cwd,
      key: item.key,
      rawValue: String(item.value),
      scope,
      minicodeHome,
    });
    saved.push({ key: item.key, value: item.value });
  }

  return {
    path: getConfigPathForScope(cwd, scope, minicodeHome),
    saved,
  };
}
