import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ToolDefinition } from "../agent/types.js";
import { resolveWorkspacePath } from "../safety/guardrails.js";
import { expectNonEmptyString } from "./helpers.js";

function expectString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new Error(`Input "${key}" must be a string.`);
  }
  return value;
}

export interface WriteFileHooks {
  afterWrite?:
    | ((filePath: string, content: string) => void | Promise<void>)
    | undefined;
}

/**
 * Minimal options needed by the write_file tool. `AgentConfig` satisfies
 * this structurally, so passing the full config keeps working.
 */
export interface WriteFileToolOptions {
  workspaceRoot: string;
}

export function createWriteFileTool(
  options: WriteFileToolOptions,
  hooks?: WriteFileHooks,
): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file with the provided content.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to workspace root.",
        },
        content: {
          type: "string",
          description: "The full file content to write.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const requestedPath = expectNonEmptyString(input, "path");
      const content = expectString(input, "content");

      const filePath = resolveWorkspacePath(requestedPath, options.workspaceRoot);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");

      if (hooks?.afterWrite) {
        await hooks.afterWrite(filePath, content);
      }

      return `Wrote ${content.length} characters to "${requestedPath}".`;
    },
  };
}
