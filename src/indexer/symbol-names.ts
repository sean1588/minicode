import type { IndexedSymbol, SymbolKind } from "./types.js";

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function buildDisplayName(
  baseName: string,
  symbol: IndexedSymbol,
  kindCount: number,
  distinctFileCount: number,
): string {
  if (distinctFileCount > 1) {
    return `${baseName} (${symbol.kind} in ${symbol.filePath}:${symbol.startLine})`;
  }

  if (kindCount === 1) {
    return `${baseName} (${symbol.kind})`;
  }

  return `${baseName} (${symbol.kind}:${symbol.startLine})`;
}

function buildQualifiedName(
  baseName: string,
  symbol: IndexedSymbol,
  kindCount: number,
  distinctFileCount: number,
): string {
  if (distinctFileCount > 1) {
    return `${baseName}#${symbol.kind}@${symbol.filePath}:${symbol.startLine}`;
  }

  if (kindCount === 1) {
    return `${baseName}#${symbol.kind}`;
  }

  return `${baseName}#${symbol.kind}:${symbol.startLine}`;
}

function countByKind(symbols: IndexedSymbol[]): Map<SymbolKind, number> {
  const counts = new Map<SymbolKind, number>();
  for (const symbol of symbols) {
    counts.set(symbol.kind, (counts.get(symbol.kind) ?? 0) + 1);
  }
  return counts;
}

function countByFile(symbols: IndexedSymbol[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    counts.set(symbol.filePath, (counts.get(symbol.filePath) ?? 0) + 1);
  }
  return counts;
}

export function getSymbolDisplayName(symbol: IndexedSymbol): string {
  return symbol.displayName ?? symbol.qualifiedName;
}

export function getSymbolLookupNames(symbol: IndexedSymbol): string[] {
  return dedupe([
    symbol.qualifiedName,
    symbol.originalQualifiedName ?? "",
    symbol.displayName ?? "",
    symbol.name,
    ...(symbol.aliases ?? []),
  ]);
}

export function normalizeIndexedSymbols(
  symbolsByFile: Map<string, IndexedSymbol[]>,
): Map<string, IndexedSymbol> {
  const allSymbols = [...symbolsByFile.values()].flat();
  const groupedByBaseName = new Map<string, IndexedSymbol[]>();

  for (const symbol of allSymbols) {
    const baseName = symbol.originalQualifiedName ?? symbol.qualifiedName;
    symbol.originalQualifiedName = baseName;
    symbol.displayName = symbol.displayName ?? baseName;
    symbol.aliases = dedupe([
      symbol.name,
      baseName,
      symbol.displayName,
      ...(symbol.aliases ?? []),
    ]);
    const existing = groupedByBaseName.get(baseName);
    if (existing) {
      existing.push(symbol);
    } else {
      groupedByBaseName.set(baseName, [symbol]);
    }
  }

  for (const [baseName, group] of groupedByBaseName) {
    if (group.length < 2) continue;

    const sorted = [...group].sort((a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.kind.localeCompare(b.kind),
    );
    const kindCounts = countByKind(sorted);
    const distinctFileCount = countByFile(sorted).size;

    for (const symbol of sorted) {
      const kindCount = kindCounts.get(symbol.kind) ?? 1;
      const displayName = buildDisplayName(baseName, symbol, kindCount, distinctFileCount);
      const qualifiedName = buildQualifiedName(baseName, symbol, kindCount, distinctFileCount);

      symbol.displayName = displayName;
      symbol.aliases = dedupe([
        symbol.name,
        baseName,
        displayName,
        ...(symbol.aliases ?? []),
      ]);
      symbol.qualifiedName = qualifiedName;
    }
  }

  return new Map(allSymbols.map((symbol) => [symbol.qualifiedName, symbol]));
}
