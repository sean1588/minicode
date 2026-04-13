import type { AgentConfig, ReasoningEffort } from "@minicode/agent-sdk";

import {
  MINICODE_HOME,
  type ConfigEnvSource,
  resolveConfigEnv,
} from "./config.js";
import { getHomeEnvPath, loadHomeEnvValues, upsertHomeEnvValues } from "./home-env.js";

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
  persistedValue: string | number | boolean | null;
  envValue: string | null;
  envSource: ConfigEnvSource | null;
  envSourcePath: string | null;
  overriddenByEnv: boolean;
}

export interface StructuredConfigPayload {
  configPath: string;
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
    envVar: "MODEL_PROVIDER",
    type: "enum",
    values: ["anthropic", "openai-compatible"],
    description: "Provider backend used to create the model client",
  },
  {
    key: "model",
    envVar: "MODEL",
    type: "string",
    description: "Default model id for new sessions",
  },
  {
    key: "maxSteps",
    envVar: "MAX_STEPS",
    type: "number",
    description: "Turn call limit before the agent pauses and waits for another prompt",
  },
  {
    key: "maxTokens",
    envVar: "MAX_TOKENS",
    type: "number",
    description: "Maximum completion tokens per model response",
  },
  {
    key: "maxContextTokens",
    envVar: "MAX_CONTEXT_TOKENS",
    type: "number",
    description: "Estimated prompt-context budget before compaction",
  },
  {
    key: "commandTimeoutMs",
    envVar: "COMMAND_TIMEOUT_MS",
    type: "number",
    description: "Shell command timeout in milliseconds",
  },
  {
    key: "maxFileSizeBytes",
    envVar: "MAX_FILE_SIZE_BYTES",
    type: "number",
    description: "Maximum file size allowed for read/edit tools",
  },
  {
    key: "confirmDestructive",
    envVar: "CONFIRM_DESTRUCTIVE",
    type: "boolean",
    description: "Whether destructive commands require confirmation",
  },
  {
    key: "keepRecentMessages",
    envVar: "KEEP_RECENT_MESSAGES",
    type: "number",
    description: "Recent messages preserved when trimming session history",
  },
  {
    key: "loopDetectionWindow",
    envVar: "LOOP_DETECTION_WINDOW",
    type: "number",
    description: "Window size for repeated-tool-call loop detection",
  },
  {
    key: "maxToolOutputChars",
    envVar: "MAX_TOOL_OUTPUT_CHARS",
    type: "number",
    description: "Maximum tool output retained before truncation",
  },
  {
    key: "openAiBaseUrl",
    envVar: "OPENAI_BASE_URL",
    type: "string",
    description: "Base URL for OpenAI-compatible providers",
  },
  {
    key: "enableFileReadDedup",
    envVar: "ENABLE_FILE_READ_DEDUP",
    type: "boolean",
    description: "Deduplicate repeated file reads in prompt context",
  },
  {
    key: "enableAdaptiveKeepRecent",
    envVar: "ENABLE_ADAPTIVE_KEEP_RECENT",
    type: "boolean",
    description: "Adjust recent-message retention based on context pressure",
  },
  {
    key: "enableToolOutputTruncation",
    envVar: "ENABLE_TOOL_OUTPUT_TRUNCATION",
    type: "boolean",
    description: "Truncate oversized tool output before storing it in session history",
  },
  {
    key: "compactionThreshold",
    envVar: "COMPACTION_THRESHOLD",
    type: "number",
    description: "Compaction threshold ratio used before a turn starts",
  },
  {
    key: "compactionModel",
    envVar: "COMPACTION_MODEL",
    type: "string",
    description: "Optional model id used for LLM-based compaction",
  },
  {
    key: "reasoningEffort",
    envVar: "REASONING_EFFORT",
    type: "enum",
    values: REASONING_VALUES,
    description: "Reasoning effort sent to supported model providers",
  },
  {
    key: "enableDynamicPrompt",
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

export function getGlobalConfigPath(
  minicodeHome = MINICODE_HOME,
): string {
  return getHomeEnvPath(minicodeHome);
}

export async function loadPersistedConfig(
  minicodeHome = MINICODE_HOME,
): Promise<Record<string, string>> {
  return loadHomeEnvValues(minicodeHome);
}

function readPersistedEnvValue(
  definition: EditableConfigDefinition,
  persisted: Record<string, string>,
): string | number | boolean | null {
  const rawValue = persisted[definition.envVar];
  if (rawValue === undefined) {
    return null;
  }

  try {
    return parseEditableValue(definition, rawValue);
  } catch {
    return rawValue;
  }
}

function serializeEditableValue(value: EditableConfigValue): string {
  return String(value);
}

export async function buildStructuredConfigPayload(
  config: AgentConfig,
  minicodeHome = MINICODE_HOME,
): Promise<StructuredConfigPayload> {
  const configPath = getGlobalConfigPath(minicodeHome);
  const persisted = await loadPersistedConfig(minicodeHome);
  const env = await resolveConfigEnv({ minicodeHome });

  return {
    configPath,
    entries: EDITABLE_CONFIG_DEFINITIONS.map((definition) => {
      const envSource = env.sources[definition.envVar] === "process"
        ? "process"
        : null;
      const envValue = envSource === "process"
        ? (env.values[definition.envVar] ?? null)
        : null;
      return {
        key: definition.key,
        type: definition.type,
        description: definition.description,
        envVar: definition.envVar,
        ...(definition.values ? { values: definition.values } : {}),
        effectiveValue: normalizePersistedValue(config[definition.key]),
        persistedValue: readPersistedEnvValue(definition, persisted),
        envValue,
        envSource,
        envSourcePath: envSource === "process" ? null : null,
        overriddenByEnv: envSource === "process",
      };
    }),
  };
}

export async function setPersistedConfigValue(options: {
  key: EditableConfigKey;
  rawValue: string;
  minicodeHome?: string;
}): Promise<{ path: string; storedValue: EditableConfigValue }> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(options.key);
  const configPath = getGlobalConfigPath(minicodeHome);
  const storedValue = parseEditableValue(definition, options.rawValue);
  await upsertHomeEnvValues({
    minicodeHome,
    values: {
      [definition.envVar]: serializeEditableValue(storedValue),
    },
  });

  return { path: configPath, storedValue };
}

export async function unsetPersistedConfigValue(options: {
  key: EditableConfigKey;
  minicodeHome?: string;
}): Promise<{ path: string }> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(options.key);
  const configPath = getGlobalConfigPath(minicodeHome);
  await upsertHomeEnvValues({
    minicodeHome,
    values: {
      [definition.envVar]: null,
    },
  });

  return { path: configPath };
}

export async function applyPersistedConfigUpdates(options: {
  updates: Record<string, string | number | boolean | null>;
  minicodeHome?: string;
}): Promise<{
  path: string;
  saved: Array<{ key: EditableConfigKey; value: string | number | boolean | null }>;
}> {
  const minicodeHome = options.minicodeHome ?? MINICODE_HOME;

  const planned = Object.entries(options.updates).map(([rawKey, value]) => {
    if (!isEditableConfigKey(rawKey)) {
      throw new Error(`Unknown editable config key "${rawKey}".`);
    }
    return { key: rawKey, value };
  });

  const saved: Array<{ key: EditableConfigKey; value: string | number | boolean | null }> = [];
  const envUpdates: Record<string, string | null> = {};
  for (const item of planned) {
    const definition = getEditableConfigDefinition(item.key);
    if (item.value === null) {
      envUpdates[definition.envVar] = null;
      saved.push({ key: item.key, value: null });
      continue;
    }

    const storedValue = parseEditableValue(definition, String(item.value));
    envUpdates[definition.envVar] = serializeEditableValue(storedValue);
    saved.push({ key: item.key, value: storedValue });
  }

  await upsertHomeEnvValues({
    minicodeHome,
    values: envUpdates,
  });

  return {
    path: getGlobalConfigPath(minicodeHome),
    saved,
  };
}
