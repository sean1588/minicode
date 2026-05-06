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

/**
 * Cap on how many disambiguation entries we render. The output flows
 * through the agent's generic tool-output truncator, which clips by
 * character count — including in the middle of a qualified name. That
 * leaves the model with an unparseable lookup key, which it then
 * guesses at, producing a "not found" loop. Bounding by entry count
 * here means each shown match has its full qualified name intact, and
 * generic char-truncation never has occasion to fire on the result.
 *
 * 12 covers virtually every real ambiguity (a name that genuinely
 * matches more is too generic to be useful — the agent should refine
 * regardless). Each entry is ~150-300 chars, so 12 entries fit
 * comfortably under typical maxToolOutputChars caps.
 */
const MAX_AMBIGUOUS_MATCHES = 12;

export function formatAmbiguousSymbolMatches(
  toolName: string,
  name: string,
  matches: IndexedSymbol[],
): string {
  const shown = matches.slice(0, MAX_AMBIGUOUS_MATCHES);
  const elided = matches.length - shown.length;
  const lines = [
    `Symbol "${name}" is ambiguous; ${matches.length} matches were found.`,
    `Re-run ${toolName} with one of these qualified or disambiguated names:`,
    "",
    ...shown.map((match) => `- ${formatSymbolMatch(match)}`),
  ];
  if (elided > 0) {
    lines.push(
      "",
      `[... and ${elided} more match(es) not shown. Refine the name (e.g. include the file path or use the qualified form like "Foo#class@path/to/file.ts") to narrow further.]`,
    );
  }
  return lines.join("\n");
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
