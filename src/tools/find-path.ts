import type { ToolDefinition } from "@sean.holung/minicode-sdk";
import { expectNonEmptyString, expectOptionalNumber } from "@sean.holung/minicode-sdk";
import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { ProjectIndex } from "../indexer/types.js";
import {
  formatAmbiguousSymbolMatches,
  resolveSymbolInput,
} from "../shared/symbol-resolution.js";

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

      const fromResolution = resolveSymbolInput(projectIndex, from);
      if (fromResolution.status === "missing") {
        return `Symbol "${from}" not found in the project index.`;
      }
      if (fromResolution.status === "ambiguous") {
        return formatAmbiguousSymbolMatches("find_path", from, fromResolution.matches);
      }
      const fromSymbol = fromResolution.symbol;

      if (to) {
        // Path between two symbols
        const toResolution = resolveSymbolInput(projectIndex, to);
        if (toResolution.status === "missing") {
          return `Symbol "${to}" not found in the project index.`;
        }
        if (toResolution.status === "ambiguous") {
          return formatAmbiguousSymbolMatches("find_path", to, toResolution.matches);
        }
        const toSymbol = toResolution.symbol;

        const path = projectIndex.findPath(
          fromSymbol.qualifiedName,
          toSymbol.qualifiedName,
          maxDepth ?? 10,
        );
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
        const paths = projectIndex.findPathToEntryPoint(fromSymbol.qualifiedName, maxDepth ?? 20);

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
