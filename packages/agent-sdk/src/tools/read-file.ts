import { readFile, stat } from "node:fs/promises";

import type { ToolDefinition } from "../agent/types.js";
import {
  resolveWorkspacePath,
  validateFileReadSize,
} from "../safety/guardrails.js";

/**
 * Minimal options needed by the read_file tool. `AgentConfig` satisfies
 * this structurally, so existing callers passing the full config keep
 * working — but consumers building embedded agents can now pass just
 * the two fields the tool actually uses.
 */
export interface ReadFileToolOptions {
  workspaceRoot: string;
  maxFileSizeBytes: number;
}
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

export function createReadFileTool(options: ReadFileToolOptions): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read file contents with line numbers. Use for config files, non-code files, or when symbol name is unknown. For large files, use offset and limit.",
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

      const filePath = resolveWorkspacePath(requestedPath, options.workspaceRoot);
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error(`"${requestedPath}" is not a file.`);
      }

      validateFileReadSize(fileStat.size, options.maxFileSizeBytes);
      const content = await readFile(filePath, "utf8");
      if (content.length === 0) {
        return "File is empty.";
      }

      const lines = content.split(/\r?\n/);
      const startLine = parseLineOffset(lines.length, offset);
      const effectiveLimit = parseLimit(limit, lines.length);
      const output = formatWithLineNumbers(content, startLine, effectiveLimit);

      // Always tell the agent how much of the file it actually saw.
      // The previous gate only fired when `limit` was undefined and the
      // default kicked in — so an explicit `limit: 260` on a 462-line
      // file silently returned the first 260 lines with no signal that
      // anything was missing. The model would then assert the missing
      // content didn't exist. Footer now fires on content-clipped, not
      // on parameter-implicit.
      const lastShownLine = Math.min(
        lines.length,
        startLine - 1 + effectiveLimit,
      );
      if (lastShownLine < lines.length) {
        const remaining = lines.length - lastShownLine;
        return `${output}\n\n[... showed lines ${startLine}-${lastShownLine} of ${lines.length}; ${remaining} more line(s). Use offset/limit to read further.]`;
      }
      return output;
    },
  };
}
