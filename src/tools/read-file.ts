import { readFile, stat } from "node:fs/promises";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import {
  resolveWorkspacePath,
  validateFileReadSize,
} from "../safety/guardrails.js";
import {
  expectNonEmptyString,
  expectOptionalNumber,
  formatWithLineNumbers,
} from "./helpers.js";

function parseLineOffset(totalLines: number, rawOffset: number | undefined): number {
  if (rawOffset === undefined) {
    return 1;
  }
  if (!Number.isInteger(rawOffset) || rawOffset === 0) {
    throw new Error(`"offset" must be a non-zero integer when provided.`);
  }

  if (rawOffset > 0) {
    return rawOffset;
  }

  return Math.max(1, totalLines + rawOffset + 1);
}

function parseLimit(rawLimit: number | undefined): number | undefined {
  if (rawLimit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(rawLimit) || rawLimit < 0) {
    throw new Error(`"limit" must be a non-negative integer when provided.`);
  }
  return rawLimit;
}

export function createReadFileTool(config: AgentConfig): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read the contents of a file and return it with line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the file relative to the workspace root.",
        },
        offset: {
          type: "number",
          description:
            "Optional 1-based line number to start from. Negative numbers count from file end.",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of lines to return.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const requestedPath = expectNonEmptyString(input, "path");
      const offset = expectOptionalNumber(input, "offset");
      const limit = expectOptionalNumber(input, "limit");
      const parsedLimit = parseLimit(limit);

      const filePath = resolveWorkspacePath(requestedPath, config.workspaceRoot);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error(`"${requestedPath}" is not a file.`);
      }

      validateFileReadSize(fileStat.size, config.maxFileSizeBytes);
      const content = await readFile(filePath, "utf8");
      if (content.length === 0) {
        return "File is empty.";
      }

      const lines = content.split(/\r?\n/);
      const startLine = parseLineOffset(lines.length, offset);
      return formatWithLineNumbers(content, startLine, parsedLimit);
    },
  };
}

