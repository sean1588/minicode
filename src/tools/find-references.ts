import type { ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import {
  expectNonEmptyString,
  expectOptionalNumber,
} from "./helpers.js";

const DEFAULT_LIMIT = 50;

export function createFindReferencesTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "find_references",
    description: "Find all symbols that reference a given symbol.",
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
      const lines = shown.map((e) => `- ${e.from} (${e.kind})`);
      const remaining = refs.length - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";
      return [
        `# References to ${symbol.qualifiedName} (${refs.length} total)`,
        "",
        ...lines,
        footer,
      ].join("\n");
    },
  };
}
