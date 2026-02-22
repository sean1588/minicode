import type { IndexedSymbol } from "./types.js";

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

/**
 * Generate a compact code map from symbols grouped by file.
 * Exported symbols are included first; if over budget, truncate with a footer.
 */
export function generateCodeMap(
  symbolsByFile: Map<string, IndexedSymbol[]>,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): string {
  const lines: string[] = ["# Project Code Map", ""];

  const exportedFirst = (a: IndexedSymbol, b: IndexedSymbol): number => {
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    return 0;
  };

  let totalTokens = estimateTokens(lines.join("\n"));
  let truncatedFiles = 0;
  let truncatedSymbols = 0;

  const sortedFiles = [...symbolsByFile.keys()].sort();

  for (const filePath of sortedFiles) {
    const symbols = symbolsByFile.get(filePath);
    if (!symbols?.length) continue;

    const sorted = [...symbols].sort(exportedFirst);
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
        continue;
      }

      fileLines.push(block);
      totalTokens += blockTokens;
    }

    if (fileLines.length > 1) {
      lines.push(...fileLines, "");
    } else {
      truncatedFiles += 1;
    }
  }

  if (truncatedSymbols > 0 || truncatedFiles > 0) {
    lines.push(
      `... and ${truncatedSymbols} more symbols in ${truncatedFiles} additional files`,
    );
  }

  return lines.join("\n").trim();
}
