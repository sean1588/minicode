import { readdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".mini-coder"]);
const MAX_ENTRIES = 200;

function parsePath(input: Record<string, unknown>): string {
  const value = input.path;
  if (value === undefined) {
    return ".";
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Input "path" must be a non-empty string when provided.`);
  }
  return value;
}

export function createListFilesTool(config: AgentConfig): ToolDefinition {
  return {
    name: "list_files",
    description: "List files and directories at a path.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional path to list, relative to workspace root. Defaults to current workspace root.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const requestedPath = parsePath(input);
      const dirPath = resolveWorkspacePath(requestedPath, config.workspaceRoot);
      const entries = await readdir(dirPath, { withFileTypes: true });

      const filtered = entries.filter(
        (entry) =>
          !(
            entry.isDirectory() &&
            EXCLUDED_DIRS.has(entry.name)
          ),
      );

      const listed = filtered
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_ENTRIES)
        .map((entry) =>
          entry.isDirectory()
            ? `[dir]  ${path.join(requestedPath, entry.name)}`
            : `[file] ${path.join(requestedPath, entry.name)}`,
        );

      if (listed.length === 0) {
        return `Directory "${requestedPath}" is empty.`;
      }

      const footer =
        filtered.length > MAX_ENTRIES
          ? `\n... and ${filtered.length - MAX_ENTRIES} more entries`
          : "";
      return listed.join("\n") + footer;
    },
  };
}

