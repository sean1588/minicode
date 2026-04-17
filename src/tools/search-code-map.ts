import type { ToolDefinition } from "@minicode/agent-sdk";
import { expectNonEmptyString, expectOptionalNumber } from "@minicode/agent-sdk";
import { getSymbolDisplayName, getSymbolLookupNames } from "../indexer/symbol-names.js";
import type { ProjectIndex } from "../indexer/types.js";
import { searchSymbols } from "../shared/symbol-search.js";

const DEFAULT_LIMIT = 30;

export function createSearchCodeMapTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "search_code_map",
    description:
      "Search the full project index for symbols by name or substring. " +
      "Use when the code map is truncated and you need to find a symbol not listed. " +
      "Returns disambiguated display names, qualified names, and file paths; use read_symbol with the result.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            "Substring to match against symbol name or qualified name (case-insensitive).",
        },
        kind: {
          type: "string",
          description:
            "Optional filter by symbol kind: function, class, interface, type, variable, method.",
        },
        limit: {
          type: "number",
          description:
            "Max results to return. Default 30.",
        },
        skip: {
          type: "number",
          description:
            "Number of results to skip (for pagination). Default 0.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const pattern = expectNonEmptyString(input, "pattern");
      const kindFilter = input.kind;
      const kind =
        typeof kindFilter === "string" && kindFilter.trim().length > 0
          ? kindFilter.trim().toLowerCase()
          : undefined;
      const limit = Math.max(
        1,
        Math.min(100, expectOptionalNumber(input, "limit") ?? DEFAULT_LIMIT),
      );
      const skip = Math.max(0, expectOptionalNumber(input, "skip") ?? 0);

      const result = searchSymbols(
        [...projectIndex.symbols.values()].map((sym) => ({
          symbol: sym,
          record: {
            name: getSymbolDisplayName(sym),
            qualifiedName: sym.qualifiedName,
            kind: sym.kind,
            filePath: sym.filePath,
            startLine: sym.startLine,
            exported: sym.exported,
          },
          lookupNames: getSymbolLookupNames(sym),
        })),
        pattern,
        { kind, limit, skip },
      );

      const shown = result.matches;
      const lines = shown.map(
        (s) =>
          `- ${getSymbolDisplayName(s)} (${s.kind}) — ${s.filePath}:${s.startLine} — qualified: ${s.qualifiedName}`,
      );
      const remaining = result.total - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";

      if (result.total === 0) {
        return `No symbols matching "${pattern}"${kind ? ` (kind: ${kind})` : ""}. Try a shorter or different pattern.`;
      }

      if (result.mode === "similar") {
        return [
          `# No exact substring matches for "${pattern}"${kind ? ` (kind: ${kind})` : ""}`,
          "",
          `Showing similar symbols instead (${result.total} total):`,
          "",
          ...lines,
          footer,
        ].join("\n");
      }

      return [
        `# Symbols matching "${pattern}" (${result.total} total)`,
        "",
        ...lines,
        footer,
      ].join("\n");
    },
  };
}
