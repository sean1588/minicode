import { readFile, stat } from "node:fs/promises";

import type { AgentConfig, ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import {
  resolveWorkspacePath,
  validateFileReadSize,
} from "../safety/guardrails.js";
import { expectNonEmptyString, expectOptionalBoolean } from "./helpers.js";

const LEADING_CONTEXT_LINES = 3;

export function createReadSymbolTool(
  config: AgentConfig,
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "read_symbol",
    description:
      "Read a specific function, class, or type definition by name. " +
      "Returns the symbol's source code and referenced type definitions. " +
      "Prefer this over read_file for code files.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Symbol name or qualified name (e.g. 'parseResponse' or 'CodingAgent.runTurn').",
        },
        includeBody: {
          type: "boolean",
          description:
            "If false, return signature only. Defaults to true.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const name = expectNonEmptyString(input, "name");
      const includeBody = expectOptionalBoolean(input, "includeBody") ?? true;

      const symbol = projectIndex.getSymbol(name);
      if (!symbol) {
        return `Symbol "${name}" not found in the project index. Try using search to find it, or use read_file to read the full file.`;
      }

      const filePath = resolveWorkspacePath(
        symbol.filePath,
        config.workspaceRoot,
      );
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        return `File "${symbol.filePath}" is not a file.`;
      }

      validateFileReadSize(fileStat.size, config.maxFileSizeBytes);
      const content = await readFile(filePath, "utf8");
      const lines = content.split(/\r?\n/);

      if (includeBody) {
        const startLine = Math.max(
          1,
          symbol.startLine - LEADING_CONTEXT_LINES,
        );
        const endLine = Math.min(lines.length, symbol.endLine);
        const excerptLines = lines.slice(startLine - 1, endLine);
        const formatted = excerptLines
          .map((line, i) => `${startLine + i}|${line}`)
          .join("\n");

        return [
          `# ${symbol.qualifiedName} (${symbol.kind})`,
          `File: ${symbol.filePath}`,
          `Lines: ${symbol.startLine}-${symbol.endLine}`,
          "",
          formatted,
        ].join("\n");
      }

      return [
        `# ${symbol.qualifiedName} (${symbol.kind})`,
        `File: ${symbol.filePath}`,
        `Lines: ${symbol.startLine}-${symbol.endLine}`,
        "",
        symbol.signature,
      ].join("\n");
    },
  };
}
