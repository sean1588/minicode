import type { ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import { expectNonEmptyString, expectOptionalNumber } from "./helpers.js";

export function createGetDependenciesTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "get_dependencies",
    description:
      "Get the dependency cone of a symbol — everything it depends on.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Symbol name or qualified name.",
        },
        depth: {
          type: "number",
          description:
            "How many levels of dependencies to include. Default 1.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const name = expectNonEmptyString(input, "name");
      const depth = expectOptionalNumber(input, "depth") ?? 1;

      const symbol = projectIndex.getSymbol(name);
      if (!symbol) {
        return `Symbol "${name}" not found in the project index.`;
      }

      const cone = projectIndex.getDependencyCone(name, depth);

      const maxItems = 50;
      const shown = cone.slice(0, maxItems);
      const lines = shown.map((s) => {
        const header = `${s.kind} ${s.qualifiedName}`;
        return `${header}\n  ${s.signature}`;
      });
      const footer =
        cone.length > maxItems
          ? `\n\n... and ${cone.length - maxItems} more`
          : "";

      return [
        `# Dependencies of ${symbol.qualifiedName} (depth ${depth})`,
        "",
        ...lines,
        footer,
      ].join("\n\n");
    },
  };
}
