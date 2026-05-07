import { readFile, stat } from "node:fs/promises";

import type { AgentConfig, ToolDefinition } from "@sean.holung/minicode-sdk";
import {
  resolveWorkspacePath,
  validateFileReadSize,
  expectNonEmptyString,
  expectOptionalBoolean,
} from "@sean.holung/minicode-sdk";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { ProjectIndex } from "../indexer/types.js";
import {
  formatAmbiguousSymbolMatches,
  resolveSymbolInput,
} from "../shared/symbol-resolution.js";

const LEADING_CONTEXT_LINES = 3;

export function createReadSymbolTool(
  config: AgentConfig,
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "read_symbol",
    description:
      "Read a specific function, class, or type definition by name. " +
      "Returns the symbol's source code, referenced types, callers, and callees. " +
      "If a bare name matches multiple symbols, returns disambiguation candidates. " +
      "PREFER this over read_file for .ts/.tsx/.js/.jsx — use the code map to find symbol names.",
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

      const resolution = resolveSymbolInput(projectIndex, name);
      if (resolution.status === "missing") {
        return `Symbol "${name}" not found in the project index. Try search_code_map first (grep over symbol signatures), then fall back to search (text/regex) or read_file (whole file) only if symbol-based retrieval can't find what you need.`;
      }
      if (resolution.status === "ambiguous") {
        return formatAmbiguousSymbolMatches("read_symbol", name, resolution.matches);
      }
      const symbol = resolution.symbol;

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

        const parts: string[] = [
          `# ${getSymbolDisplayName(symbol)} (${symbol.kind})`,
          `File: ${symbol.filePath}`,
          `Lines: ${symbol.startLine}-${symbol.endLine}`,
          "",
        ];
        if (symbol.docComment) {
          parts.push("## Description", "", symbol.docComment, "");
        }
        parts.push(formatted);

        const usedBy = projectIndex.dependencyEdges
          .filter(
            (e) =>
              e.to === symbol.qualifiedName || e.to === symbol.name,
          )
          .slice(0, 5)
          .map((e) => {
            const ref = projectIndex.getSymbol(e.from);
            return ref ? getSymbolDisplayName(ref) : e.from;
          });
        if (usedBy.length > 0) {
          parts.push("", "## Used by", "", usedBy.map((s) => `- ${s}`).join("\n"));
        }

        const calls = projectIndex.dependencyEdges
          .filter(
            (e) =>
              e.from === symbol.qualifiedName || e.from === symbol.name,
          )
          .slice(0, 5)
          .map((e) => {
            const dep = projectIndex.getSymbol(e.to);
            return dep ? getSymbolDisplayName(dep) : e.to;
          });
        if (calls.length > 0) {
          parts.push("", "## Calls", "", calls.map((s) => `- ${s}`).join("\n"));
        }

        const cone = projectIndex.getDependencyCone(symbol.qualifiedName, 1);
        const typeRefs = cone.filter(
          (s) =>
            s.qualifiedName !== symbol.qualifiedName &&
            (s.kind === "interface" || s.kind === "type"),
        );
        if (typeRefs.length > 0) {
          parts.push("", "## Referenced Types", "");
          for (const ref of typeRefs) {
            parts.push(`### ${getSymbolDisplayName(ref)}`, ref.signature, "");
          }
        }

        return parts.join("\n");
      }

      const sigParts = [
        `# ${getSymbolDisplayName(symbol)} (${symbol.kind})`,
        `File: ${symbol.filePath}`,
        `Lines: ${symbol.startLine}-${symbol.endLine}`,
        "",
      ];
      if (symbol.docComment) {
        sigParts.push("## Description", "", symbol.docComment, "");
      }
      sigParts.push(symbol.signature);
      return sigParts.join("\n");
    },
  };
}
