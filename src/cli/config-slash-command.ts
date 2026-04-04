import type { AgentConfig } from "@minicode/agent-sdk";

import { formatConfigForDisplay, MINICODE_HOME, resolveConfigEnv } from "../agent/config.js";
import {
  formatPersistedConfigValue,
  getEditableConfigDefinition,
  getEffectiveEditableConfigValue,
  isEditableConfigKey,
  listEditableConfigDefinitions,
  loadPersistedConfig,
  setPersistedConfigValue,
  unsetPersistedConfigValue,
} from "../agent/editable-config.js";

export interface ConfigSlashCommandContext {
  config: AgentConfig;
  minicodeHome?: string;
}

export interface ConfigSlashCommandResult {
  handled: boolean;
  message?: string;
}

function renderUsage(): string {
  return [
    'Usage:',
    '  /config',
    '  /config keys',
    '  /config get <key>',
    '  /config set <key> <value>',
    '  /config unset <key>',
  ].join("\n");
}

function renderEditableKeys(): string {
  const lines = [
    "Editable config keys (persisted in ~/.minicode/agent.config.json; environment variables take precedence):",
  ];

  for (const definition of listEditableConfigDefinitions()) {
    const valueHint = definition.type === "enum"
      ? `<${definition.values?.join("|")}>`
      : `<${definition.type}>`;
    lines.push(
      `  ${definition.key} ${valueHint} — ${definition.description} (env: ${definition.envVar})`,
    );
  }

  lines.push("");
  lines.push('Use "/config set <key> <value>" to update your global config.');
  lines.push("Secrets like API keys stay env-only for now.");
  return lines.join("\n");
}

async function renderConfigValue(
  key: string,
  context: ConfigSlashCommandContext,
): Promise<string> {
  if (!isEditableConfigKey(key)) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);
  const persisted = await loadPersistedConfig(minicodeHome);
  const env = await resolveConfigEnv({ minicodeHome });
  const envValue = env.values[definition.envVar];

  return [
    `${definition.key}`,
    `  effective: ${getEffectiveEditableConfigValue(context.config, key)}`,
    `  config file: ${formatPersistedConfigValue(persisted[definition.fileKey])}`,
    `  env override (${definition.envVar}): ${formatPersistedConfigValue(envValue)}`,
  ].join("\n");
}

async function persistConfigValue(
  key: string,
  rawValue: string,
  context: ConfigSlashCommandContext,
): Promise<string> {
  if (!isEditableConfigKey(key)) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);
  const env = await resolveConfigEnv({ minicodeHome });

  try {
    const result = await setPersistedConfigValue({
      key,
      rawValue,
      minicodeHome,
    });
    const lines = [
      `Saved config: ${key} = ${formatPersistedConfigValue(result.storedValue)}`,
      `File: ${result.path}`,
      "Restart minicode to pick up persisted config changes in a new session.",
    ];
    if (env.values[definition.envVar] !== undefined) {
      lines.push(`Note: ${definition.envVar} is currently set and will override this persisted value until it is unset.`);
    }
    return lines.join("\n");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return `Failed to save config: ${message}`;
  }
}

async function removeConfigValue(
  key: string,
  context: ConfigSlashCommandContext,
): Promise<string> {
  if (!isEditableConfigKey(key)) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);
  const env = await resolveConfigEnv({ minicodeHome });

  await unsetPersistedConfigValue({
    key,
    minicodeHome,
  });

  const lines = [
    `Removed persisted value for "${key}".`,
    `File: ${minicodeHome}/agent.config.json`,
    "Restart minicode to ensure the updated config is applied in a new session.",
  ];
  if (env.values[definition.envVar] !== undefined) {
    lines.push(`Note: ${definition.envVar} is still set in the environment, so the effective value may remain unchanged.`);
  }
  return lines.join("\n");
}

export async function handleConfigSlashCommand(
  trimmed: string,
  context: ConfigSlashCommandContext,
): Promise<ConfigSlashCommandResult> {
  if (!(trimmed === "/config" || trimmed.startsWith("/config "))) {
    return { handled: false };
  }

  const rest = trimmed.slice("/config".length).trim();
  if (rest.length === 0) {
    return { handled: true, message: formatConfigForDisplay(context.config) };
  }

  const tokens = rest.split(/\s+/);
  const [subcommand, ...subArgs] = tokens;

  if (subcommand === "keys") {
    return { handled: true, message: renderEditableKeys() };
  }

  if (subcommand === "get") {
    if (subArgs.length !== 1) {
      return { handled: true, message: renderUsage() };
    }
    return {
      handled: true,
      message: await renderConfigValue(subArgs[0]!, context),
    };
  }

  if (subcommand === "set") {
    if (subArgs.length < 2) {
      return { handled: true, message: renderUsage() };
    }
    const [key, ...valueParts] = subArgs;
    return {
      handled: true,
      message: await persistConfigValue(key!, valueParts.join(" "), context),
    };
  }

  if (subcommand === "unset") {
    if (subArgs.length !== 1) {
      return { handled: true, message: renderUsage() };
    }
    return {
      handled: true,
      message: await removeConfigValue(subArgs[0]!, context),
    };
  }

  return { handled: true, message: renderUsage() };
}
