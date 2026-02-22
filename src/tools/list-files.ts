import { readdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";

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

      const listed = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) =>
          entry.isDirectory()
            ? `[dir]  ${path.join(requestedPath, entry.name)}`
            : `[file] ${path.join(requestedPath, entry.name)}`,
        );

      if (listed.length === 0) {
        return `Directory "${requestedPath}" is empty.`;
      }

      return listed.join("\n");
    },
  };
}

