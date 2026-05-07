import type { AgentConfig } from "@sean.holung/minicode-sdk";

import { formatConfigForDisplay, MINICODE_HOME, resolveConfigEnv } from "../agent/config.js";
import {
  buildStructuredConfigPayload,
  formatPersistedConfigValue,
  getEditableConfigDefinition,
  getEffectiveEditableConfigValue,
  isEditableConfigKey,
  listEditableConfigDefinitions,
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
    "Editable config keys (persisted in ~/.minicode/.env; exported shell environment variables take precedence):",
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
  lines.push('Use "/config set <key> <value>" to update ~/.minicode/.env.');
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
  const payload = await buildStructuredConfigPayload(context.config, minicodeHome);
  const entry = payload.entries.find((item) => item.key === key);
  if (!entry) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  return [
    `${definition.key}`,
    `  effective: ${getEffectiveEditableConfigValue(context.config, key)}`,
    `  saved in ~/.minicode/.env: ${formatPersistedConfigValue(entry.persistedValue)}`,
    `  exported env override (${definition.envVar}): ${formatPersistedConfigValue(entry.envValue)}`,
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
    if (env.sources[definition.envVar] === "process") {
      lines.push(`Note: ${definition.envVar} is currently exported in your shell and will override this saved value until it is unset.`);
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
    `File: ${minicodeHome}/.env`,
    "Restart minicode to ensure the updated config is applied in a new session.",
  ];
  if (env.sources[definition.envVar] === "process") {
    lines.push(`Note: ${definition.envVar} is still exported in your shell, so the effective value may remain unchanged.`);
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
