import type { DependencyEdge, IndexedSymbol } from "./types.js";

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
  return `${indent}${symbol.kind} ${symbol.qualifiedName}\n${indent}  ${symbol.signature}`;
}

function isEntryPointFile(filePath: string): boolean {
  return filePath === "src/index.ts" || filePath.endsWith("/index.ts");
}

function createSymbolRanker(edges: DependencyEdge[]) {
  const refCount = new Map<string, number>();
  for (const e of edges) {
    refCount.set(e.to, (refCount.get(e.to) ?? 0) + 1);
  }
  return (a: IndexedSymbol, b: IndexedSymbol): number => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    const refA = refCount.get(a.qualifiedName) ?? 0;
    const refB = refCount.get(b.qualifiedName) ?? 0;
    if (refA !== refB) return refB - refA;
    const entryA = isEntryPointFile(a.filePath) ? 1 : 0;
    const entryB = isEntryPointFile(b.filePath) ? 1 : 0;
    return entryB - entryA;
  };
}

export interface CodeMapResult {
  text: string;
  shownCount: number;
  totalCount: number;
}

/**
 * Generate a compact code map from symbols grouped by file.
 * Ranks symbols by: exported > high reference count > entry points.
 * When over budget, truncates with a footer.
 */
export function generateCodeMap(
  symbolsByFile: Map<string, IndexedSymbol[]>,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  dependencyEdges?: DependencyEdge[],
): CodeMapResult {
  const totalCount = [...symbolsByFile.values()].reduce(
    (sum, syms) => sum + syms.length,
    0,
  );

  const lines: string[] = ["# Project Code Map", ""];
  const rank = dependencyEdges
    ? createSymbolRanker(dependencyEdges)
    : (a: IndexedSymbol, b: IndexedSymbol) =>
        (a.exported === b.exported ? 0 : a.exported ? -1 : 1);

  let totalTokens = estimateTokens(lines.join("\n"));
  let truncatedSymbols = 0;
  let shownCount = 0;
  const filesWithTruncation = new Set<string>();

  const sortedFiles = [...symbolsByFile.keys()].sort();

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
