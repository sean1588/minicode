import type { ToolDefinition } from "../agent/types.js";
import type { ProjectIndex } from "../indexer/types.js";
import { expectNonEmptyString, expectOptionalNumber } from "./helpers.js";

export function createGetDependenciesTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "get_dependencies",
    description:
      "Get the dependency cone of a symbol — everything it calls or depends on. Use to understand implementation and data flow. Prefer over reading full files.",
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
      const depth = expectOptionalNumber(input, "depth") ?? 1;
      const skip = Math.max(0, expectOptionalNumber(input, "skip") ?? 0);
      const limit = Math.max(1, Math.min(100, expectOptionalNumber(input, "limit") ?? 50));

      const symbol = projectIndex.getSymbol(name);
      if (!symbol) {
        return `Symbol "${name}" not found in the project index.`;
      }

      const cone = projectIndex.getDependencyCone(name, depth);

      const shown = cone.slice(skip, skip + limit);
      const lines = shown.map((s) => {
        const header = `${s.kind} ${s.qualifiedName}`;
        return `${header}\n  ${s.signature}`;
      });
      const remaining = cone.length - skip - shown.length;
      const footer =
        remaining > 0
          ? `\n\n... and ${remaining} more (use skip: ${skip + limit}, limit: ${limit} for next page)`
          : "";

      return [
        `# Dependencies of ${symbol.qualifiedName} (depth ${depth}, ${cone.length} total)`,
        "",
        ...lines,
        footer,
      ].join("\n\n");
    },
  };
}
