import { getSymbolDisplayName } from "./symbol-names.js";
import type { CodeMapResult, DependencyEdge, IndexedSymbol } from "./types.js";

const DEFAULT_TOKEN_BUDGET = 1500;
const APPROX_CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function formatSymbol(
  symbol: IndexedSymbol,
  indent: string,
  isMethod: boolean,
): string {
  if (isMethod) {
    return `${indent}  ${symbol.signature}`;
  }
  return `${indent}${symbol.kind} ${getSymbolDisplayName(symbol)}\n${indent}  ${symbol.signature}`;
}

function isEntryPointFile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, "/");
  return /(?:^|\/)index\.[jt]sx?$/.test(name);
}

/**
 * Build adjacency maps from edges for O(1) lookups per symbol.
 */
function buildAdjacencyMaps(edges: DependencyEdge[]): {
  byFrom: Map<string, DependencyEdge[]>;
  byTo: Map<string, DependencyEdge[]>;
} {
  const byFrom = new Map<string, DependencyEdge[]>();
  const byTo = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const fromList = byFrom.get(edge.from);
    if (fromList) fromList.push(edge); else byFrom.set(edge.from, [edge]);
    const toList = byTo.get(edge.to);
    if (toList) toList.push(edge); else byTo.set(edge.to, [edge]);
  }
  return { byFrom, byTo };
}

/**
 * Build the set of symbols related to focus symbols via dependency edges.
 * Expands 1 hop outbound (what focus symbols depend on) and 1 hop inbound
 * (what depends on focus symbols).
 */
function expandFocusSet(
  focusSymbols: Set<string>,
  adjacency: { byFrom: Map<string, DependencyEdge[]>; byTo: Map<string, DependencyEdge[]> },
): Set<string> {
  const expanded = new Set(focusSymbols);
  for (const sym of focusSymbols) {
    // Outbound: focus symbol depends on something
    const outEdges = adjacency.byFrom.get(sym);
    if (outEdges) {
      for (const edge of outEdges) expanded.add(edge.to);
    }
    // Inbound: something depends on focus symbol
    const inEdges = adjacency.byTo.get(sym);
    if (inEdges) {
      for (const edge of inEdges) expanded.add(edge.from);
    }
  }
  return expanded;
}

function createSymbolRanker(
  adjacency: { byFrom: Map<string, DependencyEdge[]>; byTo: Map<string, DependencyEdge[]> },
  focusSymbols?: Set<string>,
) {
  const refCount = new Map<string, number>();
  for (const [target, edges] of adjacency.byTo) {
    refCount.set(target, edges.length);
  }

  // Expand focus set to include 1-hop neighbors in the dependency graph
  const boosted = focusSymbols?.size
    ? expandFocusSet(focusSymbols, adjacency)
    : undefined;

  return (a: IndexedSymbol, b: IndexedSymbol): number => {
    // Focus-boosted symbols always sort first
    if (boosted) {
      const aFocused = boosted.has(a.qualifiedName);
      const bFocused = boosted.has(b.qualifiedName);
      if (aFocused !== bFocused) return aFocused ? -1 : 1;
    }

    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    const refA = refCount.get(a.qualifiedName) ?? 0;
    const refB = refCount.get(b.qualifiedName) ?? 0;
    if (refA !== refB) return refB - refA;
    const entryA = isEntryPointFile(a.filePath) ? 1 : 0;
    const entryB = isEntryPointFile(b.filePath) ? 1 : 0;
    return entryB - entryA;
  };
}

export type { CodeMapResult };

/**
 * Generate a compact code map from symbols grouped by file.
 * Ranks symbols by: focus-boosted > exported > high reference count > entry points.
 * When over budget, truncates with a footer.
 *
 * @param focusSymbols Optional set of symbol qualified names to boost to the top.
 *   These symbols (and their 1-hop dependency neighbors) will be ranked above all
 *   others, ensuring they survive truncation within the token budget.
 */
export function generateCodeMap(
  symbolsByFile: Map<string, IndexedSymbol[]>,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  dependencyEdges?: DependencyEdge[],
  focusSymbols?: Set<string>,
): CodeMapResult {
  const totalCount = [...symbolsByFile.values()].reduce(
    (sum, syms) => sum + syms.length,
    0,
  );

  const lines: string[] = ["# Project Code Map", ""];
  const adjacency = dependencyEdges
    ? buildAdjacencyMaps(dependencyEdges)
    : { byFrom: new Map<string, DependencyEdge[]>(), byTo: new Map<string, DependencyEdge[]>() };
  const rank = dependencyEdges
    ? createSymbolRanker(adjacency, focusSymbols)
    : (a: IndexedSymbol, b: IndexedSymbol) =>
        (a.exported === b.exported ? 0 : a.exported ? -1 : 1);

  let totalTokens = estimateTokens(lines.join("\n"));
  let truncatedSymbols = 0;
  let shownCount = 0;
  const filesWithTruncation = new Set<string>();

  // When we have focus symbols, sort files so that files containing
  // focused symbols come first in the code map.
  const boosted = focusSymbols?.size && dependencyEdges
    ? expandFocusSet(focusSymbols, adjacency)
    : undefined;

  const sortedFiles = [...symbolsByFile.keys()].sort((a, b) => {
    if (boosted) {
      const aHasFocus = symbolsByFile.get(a)?.some(
        (s) => boosted.has(s.qualifiedName),
      ) ?? false;
      const bHasFocus = symbolsByFile.get(b)?.some(
        (s) => boosted.has(s.qualifiedName),
      ) ?? false;
      if (aHasFocus !== bHasFocus) return aHasFocus ? -1 : 1;
    }
    return a.localeCompare(b);
  });

  for (const filePath of sortedFiles) {
    const symbols = symbolsByFile.get(filePath);
    if (!symbols?.length) continue;

    const sorted = [...symbols].sort(rank);
    let currentClass: string | null = null;

    const fileLines: string[] = [`  ${filePath}`];

    for (const symbol of sorted) {
      const isMethod = symbol.kind === "method";
      const indent = isMethod && currentClass ? "    " : "  "; // methods nest under class
      if (symbol.kind === "class") {
        currentClass = symbol.name;
      } else if (!isMethod) {
        currentClass = null;
      }

      const block = formatSymbol(symbol, indent, isMethod);
      const blockTokens = estimateTokens(block);

      if (totalTokens + blockTokens > tokenBudget) {
        truncatedSymbols += 1;
        filesWithTruncation.add(filePath);
        continue;
      }

      fileLines.push(block);
      totalTokens += blockTokens;
      shownCount += 1;
    }

    if (fileLines.length > 1) {
      lines.push(...fileLines, "");
    } else {
      truncatedSymbols += symbols.length;
      filesWithTruncation.add(filePath);
    }
  }

  if (truncatedSymbols > 0) {
    const fileCount = filesWithTruncation.size;
    lines.push(
      `... and ${truncatedSymbols} more symbols in ${fileCount} file${fileCount === 1 ? "" : "s"}`,
    );
  }

  return {
    text: lines.join("\n").trim(),
    shownCount,
    totalCount,
  };
}
