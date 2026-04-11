import { getSymbolDisplayName } from "../indexer/symbol-names.js";
import type { IndexedSymbol } from "../indexer/types.js";

export type SymbolResolution =
  | { status: "missing" }
  | { status: "ambiguous"; matches: IndexedSymbol[] }
  | { status: "resolved"; symbol: IndexedSymbol };

export function resolveSymbolInput(
  projectIndex: { getSymbolMatches(name: string): IndexedSymbol[] },
  name: string,
): SymbolResolution {
  const matches = projectIndex.getSymbolMatches(name);
  if (matches.length === 0) {
    return { status: "missing" };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", matches };
  }
  return { status: "resolved", symbol: matches[0]! };
}

export function formatSymbolMatch(match: IndexedSymbol): string {
  return `${getSymbolDisplayName(match)} (${match.kind}) — ${match.filePath}:${match.startLine} — qualified: ${match.qualifiedName}`;
}

export function formatAmbiguousSymbolMatches(
  toolName: string,
  name: string,
  matches: IndexedSymbol[],
): string {
  return [
    `Symbol "${name}" is ambiguous; ${matches.length} matches were found.`,
    `Re-run ${toolName} with one of these qualified or disambiguated names:`,
    "",
    ...matches.map((match) => `- ${formatSymbolMatch(match)}`),
  ].join("\n");
}

export function serializeSymbolMatch(match: IndexedSymbol): {
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
} {
  return {
    name: getSymbolDisplayName(match),
    qualifiedName: match.qualifiedName,
    kind: match.kind,
    filePath: match.filePath,
    startLine: match.startLine,
    endLine: match.endLine,
    signature: match.signature,
  };
}
