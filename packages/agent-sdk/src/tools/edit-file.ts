import { readFile, writeFile } from "node:fs/promises";

import type { ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";
import { expectNonEmptyString } from "./helpers.js";

/**
 * Minimal options needed by the edit_file tool. `AgentConfig` satisfies
 * this structurally, so passing the full config keeps working.
 */
export interface EditFileToolOptions {
  workspaceRoot: string;
}

function expectString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`Input "${key}" must be a string.`);
  }
  return value;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }
  return count;
}

export interface EditFileHooks {
  afterEdit?:
    | ((filePath: string, content: string) => void | Promise<void>)
    | undefined;
}

export function createEditFileTool(
  options: EditFileToolOptions,
  hooks?: EditFileHooks,
): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Replace exactly one instance of old_string with new_string in a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to file relative to workspace root.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace (must match once).",
        },
        new_string: {
          type: "string",
          description: "Replacement text.",
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const requestedPath = expectNonEmptyString(input, "path");
      const oldString = expectNonEmptyString(input, "old_string");
      const newString = expectString(input, "new_string");

      const filePath = resolveWorkspacePath(requestedPath, options.workspaceRoot);
      const current = await readFile(filePath, "utf8");
      const occurrences = countOccurrences(current, oldString);

      if (occurrences === 0) {
        throw new Error(
          `old_string was not found in "${requestedPath}".`,
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_string matched ${occurrences} times in "${requestedPath}". It must be unique.`,
        );
      }

      const updated = current.replace(oldString, newString);
      await writeFile(filePath, updated, "utf8");

      if (hooks?.afterEdit) {
        await hooks.afterEdit(filePath, updated);
      }

      return `Updated "${requestedPath}" successfully.`;
    },
  };
}
