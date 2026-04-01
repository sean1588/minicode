import type { ToolDefinition } from "@minicode/agent-sdk";
import { expectNonEmptyString, expectOptionalNumber } from "@minicode/agent-sdk";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { ProjectIndex } from "../indexer/types.js";

export function createFindPathTool(
  projectIndex: ProjectIndex,
): ToolDefinition {
  return {
    name: "find_path",
    description:
      "Find the path between two symbols in the dependency graph, or trace a symbol back to its entry point. Use to understand execution flow and how a function gets called.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description:
            "Symbol name or qualified name to start from.",
        },
        to: {
          type: "string",
          description:
            "Symbol name or qualified name to reach. If omitted, traces back to entry point(s).",
        },
        max_depth: {
          type: "number",
          description:
            "Maximum search depth. Default 10 for path finding, 20 for entry point tracing.",
        },
      },
      required: ["from"],
      additionalProperties: false,
    },
    execute: async (input: Record<string, unknown>): Promise<string> => {
      const from = expectNonEmptyString(input, "from");
      const to = typeof input.to === "string" && input.to.length > 0 ? input.to : undefined;
      const maxDepth = expectOptionalNumber(input, "max_depth");

      const fromSymbol = projectIndex.getSymbol(from);
      if (!fromSymbol) {
        return `Symbol "${from}" not found in the project index.`;
      }

      if (to) {
        // Path between two symbols
        const toSymbol = projectIndex.getSymbol(to);
        if (!toSymbol) {
          return `Symbol "${to}" not found in the project index.`;
        }

        const path = projectIndex.findPath(from, to, maxDepth ?? 10);
        if (path.length === 0) {
          return `No path found between "${from}" and "${to}".`;
        }

        const lines = path.map((s, i) => {
          const arrow = i < path.length - 1 ? " ->" : "";
          return `${i + 1}. [${s.kind}] ${getSymbolDisplayName(s)} (${s.filePath}:${s.startLine})${arrow}`;
        });

        return [
          `# Path from ${getSymbolDisplayName(fromSymbol)} to ${getSymbolDisplayName(toSymbol)} (${path.length} symbols)`,
          "",
          ...lines,
        ].join("\n");
      } else {
        // Trace to entry point(s)
        const paths = projectIndex.findPathToEntryPoint(from, maxDepth ?? 20);

        if (paths.length === 0) {
          return `No entry point paths found for "${from}". It may itself be an entry point.`;
        }

        const sections = paths.map((p, pi) => {
          const lines = p.map((s, i) => {
            const arrow = i < p.length - 1 ? " ->" : "";
            return `  ${i + 1}. [${s.kind}] ${getSymbolDisplayName(s)} (${s.filePath}:${s.startLine})${arrow}`;
          });
          return [`## Path ${pi + 1}`, ...lines].join("\n");
        });

        return [
          `# Entry point paths for ${getSymbolDisplayName(fromSymbol)} (${paths.length} path${paths.length === 1 ? "" : "s"})`,
          "",
          ...sections,
        ].join("\n\n");
      }
    },
  };
}
