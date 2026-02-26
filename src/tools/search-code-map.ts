import type { ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import {
  expectNonEmptyString,
  expectOptionalNumber,
} from "./helpers.js";

const DEFAULT_LIMIT = 30;

function matchesPattern(
  text: string,
  pattern: string,
): boolean {
  const lowerText = text.toLowerCase();
  const lowerPattern = pattern.toLowerCase();
  return lowerText.includes(lowerPattern);
}

export function createSearchCodeMapTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "search_code_map",
    description:
      "Search the full project index for symbols by name or substring. " +
      "Use when the code map is truncated and you need to find a symbol not listed. " +
      "Returns qualified names and file paths; use read_symbol with the result.",
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

      const symbols = [...projectIndex.symbols.values()];
      const matches = symbols.filter((sym) => {
        if (!matchesPattern(sym.name, pattern) && !matchesPattern(sym.qualifiedName, pattern)) {
          return false;
        }
        if (kind && sym.kind !== kind) {
          return false;
        }
        return true;
      });

      const shown = matches.slice(skip, skip + limit);
      const lines = shown.map(
        (s) => `- ${s.qualifiedName} (${s.kind}) — ${s.filePath}`,
      );
      const remaining = matches.length - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";

      if (matches.length === 0) {
        return `No symbols matching "${pattern}"${kind ? ` (kind: ${kind})` : ""}. Try a shorter or different pattern.`;
      }

      return [
        `# Symbols matching "${pattern}" (${matches.length} total)`,
        "",
        ...lines,
        footer,
      ].join("\n");
    },
  };
}
