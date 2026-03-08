import { readdir } from "node:fs/promises";
import path from "node:path";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";
import { expectOptionalNumber } from "./helpers.js";

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".minicode"]);
const DEFAULT_LIMIT = 200;

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
        skip: {
          type: "number",
          description:
            "Number of entries to skip (for pagination). Default 0.",
        },
        limit: {
          type: "number",
          description:
            "Max number of entries to return. Default 200.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const requestedPath = parsePath(input);
      const skip = Math.max(0, expectOptionalNumber(input, "skip") ?? 0);
      const limit = Math.max(1, Math.min(500, expectOptionalNumber(input, "limit") ?? DEFAULT_LIMIT));

      const dirPath = resolveWorkspacePath(requestedPath, config.workspaceRoot);
      const entries = await readdir(dirPath, { withFileTypes: true });

      const filtered = entries.filter(
        (entry) =>
          !(
            entry.isDirectory() &&
            EXCLUDED_DIRS.has(entry.name)
          ),
      );

      const sorted = filtered.sort((a, b) => a.name.localeCompare(b.name));
      const listed = sorted
        .slice(skip, skip + limit)
        .map((entry) =>
          entry.isDirectory()
            ? `[dir]  ${path.join(requestedPath, entry.name)}`
            : `[file] ${path.join(requestedPath, entry.name)}`,
        );

      if (listed.length === 0) {
        return `Directory "${requestedPath}" is empty.`;
      }

      const remaining = sorted.length - skip - listed.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";
      return listed.join("\n") + footer;
    },
  };
}
