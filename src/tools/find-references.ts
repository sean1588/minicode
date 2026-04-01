import type { ToolDefinition } from "@minicode/agent-sdk";
import { expectNonEmptyString, expectOptionalNumber } from "@minicode/agent-sdk";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { ProjectIndex } from "../indexer/types.js";

const DEFAULT_LIMIT = 50;

export function createFindReferencesTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "find_references",
    description:
      "Find all symbols that reference or call a given symbol. Use to understand impact before changes. Prefer over search when you know the symbol name.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Symbol name or qualified name to find references for.",
        },
        skip: {
          type: "number",
          description:
            "Number of results to skip (for pagination). Default 0.",
        },
        limit: {
          type: "number",
          description:
            "Max number of results to return. Default 50.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const name = expectNonEmptyString(input, "name");
      const skip = Math.max(0, expectOptionalNumber(input, "skip") ?? 0);
      const limit = Math.max(1, Math.min(100, expectOptionalNumber(input, "limit") ?? DEFAULT_LIMIT));

      const symbol = projectIndex.getSymbol(name);
      if (!symbol) {
        return `Symbol "${name}" not found in the project index.`;
      }

      const refs = projectIndex.dependencyEdges.filter(
        (e) => e.to === symbol.qualifiedName || e.to === symbol.name,
      );

      if (refs.length === 0) {
        return `No references found for "${name}".`;
      }

      const shown = refs.slice(skip, skip + limit);
      const lines = shown.map((e) => {
        const fromSymbol = projectIndex.getSymbol(e.from);
        const label = fromSymbol ? getSymbolDisplayName(fromSymbol) : e.from;
        return `- ${label} (${e.kind})`;
      });
      const remaining = refs.length - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";
      return [
        `# References to ${getSymbolDisplayName(symbol)} (${refs.length} total)`,
        "",
        ...lines,
        footer,
      ].join("\n");
    },
  };
}
