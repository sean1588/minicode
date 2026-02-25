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

const DEFAULT_LINE_LIMIT = 500;

function parseLimit(
  rawLimit: number | undefined,
  totalLines: number,
): number {
  if (rawLimit !== undefined) {
    if (!Number.isInteger(rawLimit) || rawLimit < 0) {
      throw new Error(`"limit" must be a non-negative integer when provided.`);
    }
    return rawLimit;
  }
  if (totalLines > DEFAULT_LINE_LIMIT) {
    return DEFAULT_LINE_LIMIT;
  }
  return totalLines;
}

export function createReadFileTool(config: AgentConfig): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read file contents with line numbers. For large files, use offset and limit to read only needed lines. Prefer read_symbol for code files when you need a specific function or class.",
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
      const effectiveLimit = parseLimit(limit, lines.length);
      const output = formatWithLineNumbers(content, startLine, effectiveLimit);

      if (
        limit === undefined &&
        lines.length > DEFAULT_LINE_LIMIT &&
        effectiveLimit < lines.length
      ) {
        const remaining = Math.max(
          0,
          lines.length - (startLine - 1) - effectiveLimit,
        );
        return `${output}\n\n[... truncated, ${remaining} more lines. Use offset and limit to read specific sections.]`;
      }
      return output;
    },
  };
}

