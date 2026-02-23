import type { ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import { expectNonEmptyString } from "./helpers.js";

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
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const name = expectNonEmptyString(input, "name");

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

      const lines = refs.map((e) => `- ${e.from} (${e.kind})`);
      return [
        `# References to ${symbol.qualifiedName}`,
        "",
        ...lines,
      ].join("\n");
    },
  };
}
