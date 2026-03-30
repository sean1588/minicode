import process from "node:process";

import type { AgentConfig } from "@minicode/agent-sdk";

import { formatConfigForDisplay, MINICODE_HOME } from "../agent/config.js";
import {
  formatPersistedConfigValue,
  getEditableConfigDefinition,
  getEffectiveEditableConfigValue,
  isEditableConfigKey,
  listEditableConfigDefinitions,
  loadPersistedConfigLayers,
  setPersistedConfigValue,
  unsetPersistedConfigValue,
  type EditableConfigScope,
} from "../agent/editable-config.js";

export interface ConfigSlashCommandContext {
  config: AgentConfig;
  cwd?: string;
  minicodeHome?: string;
}

export interface ConfigSlashCommandResult {
  handled: boolean;
  message?: string;
}

function parseScope(tokens: string[]): { scope: EditableConfigScope; args: string[] } {
  const args = tokens.filter((token) => token !== "--global");
  return {
    scope: tokens.includes("--global") ? "global" : "workspace",
    args,
  };
}

function renderUsage(): string {
  return [
    'Usage:',
    '  /config',
    '  /config keys',
    '  /config get <key>',
    '  /config set <key> <value> [--global]',
    '  /config unset <key> [--global]',
  ].join("\n");
}

function renderEditableKeys(): string {
  const lines = [
    "Editable config keys (persisted in agent.config.json; environment variables still take precedence):",
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
  lines.push('Use "/config set <key> <value>" for workspace config or add "--global" for ~/.minicode/agent.config.json.');
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

  const cwd = context.cwd ?? process.cwd();
  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);
  const layers = await loadPersistedConfigLayers(cwd, minicodeHome);
  const envValue = process.env[definition.envVar];

  return [
    `${definition.key}`,
    `  effective: ${getEffectiveEditableConfigValue(context.config, key)}`,
    `  workspace file: ${formatPersistedConfigValue(layers.workspace[definition.fileKey])}`,
    `  global file: ${formatPersistedConfigValue(layers.global[definition.fileKey])}`,
    `  env override (${definition.envVar}): ${formatPersistedConfigValue(envValue)}`,
  ].join("\n");
}

async function persistConfigValue(
  key: string,
  rawValue: string,
  context: ConfigSlashCommandContext,
  scope: EditableConfigScope,
): Promise<string> {
  if (!isEditableConfigKey(key)) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  const cwd = context.cwd ?? process.cwd();
  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);

  try {
    const result = await setPersistedConfigValue({
      cwd,
      key,
      rawValue,
      scope,
      minicodeHome,
    });
    const lines = [
      `Saved ${scope} config: ${key} = ${formatPersistedConfigValue(result.storedValue)}`,
      `File: ${result.path}`,
      "Restart minicode to pick up persisted config changes in a new session.",
    ];
    if (process.env[definition.envVar] !== undefined) {
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
  scope: EditableConfigScope,
): Promise<string> {
  if (!isEditableConfigKey(key)) {
    return `Unknown editable config key "${key}".\n\n${renderEditableKeys()}`;
  }

  const cwd = context.cwd ?? process.cwd();
  const minicodeHome = context.minicodeHome ?? MINICODE_HOME;
  const definition = getEditableConfigDefinition(key);

  await unsetPersistedConfigValue({
    cwd,
    key,
    scope,
    minicodeHome,
  });

  const lines = [
    `Removed ${scope} persisted value for "${key}".`,
    `File: ${scope === "global" ? `${minicodeHome}/agent.config.json` : `${cwd}/agent.config.json`}`,
    "Restart minicode to ensure the updated config is applied in a new session.",
  ];
  if (process.env[definition.envVar] !== undefined) {
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
  const { scope, args } = parseScope(tokens);
  const [subcommand, ...subArgs] = args;

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
      message: await persistConfigValue(key!, valueParts.join(" "), context, scope),
    };
  }

  if (subcommand === "unset") {
    if (subArgs.length !== 1) {
      return { handled: true, message: renderUsage() };
    }
    return {
      handled: true,
      message: await removeConfigValue(subArgs[0]!, context, scope),
    };
  }

  return { handled: true, message: renderUsage() };
}
