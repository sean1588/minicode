import {
  compareGraphNodeIds,
  getGraphNodeLabel,
  matchesGraphNodeQuery,
  type GraphSymbolNodeLike,
} from "./graph-symbols.js";

export interface GraphSearchNodeLike extends GraphSymbolNodeLike {
  kind?: string;
  filePath?: string;
  file?: string;
}

export interface GraphSymbolSearchResult {
  type: "symbol";
  id: string;
  label: string;
  subtitle: string;
  kind: string;
}

export interface GraphFileSearchResult {
  type: "file";
  id: string;
  label: string;
  subtitle: string;
  kind: "file";
  symbolCount: number;
}

export type GraphSearchResult = GraphSymbolSearchResult | GraphFileSearchResult;

export function getGraphNodeFilePath(node: GraphSearchNodeLike): string {
  return node.filePath || node.file || "";
}

export function buildGraphFileIndex(
  nodes: ReadonlyMap<string, GraphSearchNodeLike>,
): Map<string, string[]> {
  const files = new Map<string, string[]>();

  for (const [id, node] of nodes) {
    const filePath = getGraphNodeFilePath(node);
    if (!filePath) continue;

    const existing = files.get(filePath);
    if (existing) {
      existing.push(id);
    } else {
      files.set(filePath, [id]);
    }
  }

  for (const symbolIds of files.values()) {
    symbolIds.sort((a, b) => compareGraphNodeIds(a, b, nodes));
  }

  return files;
}

export function compareGraphFilePaths(
  a: string,
  b: string,
  fileIndex: ReadonlyMap<string, readonly string[]>,
): number {
  const countDifference = (fileIndex.get(b)?.length ?? 0) - (fileIndex.get(a)?.length ?? 0);
  if (countDifference !== 0) {
    return countDifference;
  }

  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function matchesGraphFileQuery(query: string, filePath: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return false;
  }

  return filePath.toLowerCase().includes(normalizedQuery);
}

interface BuildGraphSearchResultsOptions {
  query: string;
  symbolIds: readonly string[];
  nodes: ReadonlyMap<string, GraphSearchNodeLike>;
  fileIndex: ReadonlyMap<string, readonly string[]>;
  symbolLimit?: number;
  fileLimit?: number;
}

export function buildGraphSearchResults({
  query,
  symbolIds,
  nodes,
  fileIndex,
  symbolLimit = 12,
  fileLimit = 8,
}: BuildGraphSearchResultsOptions): GraphSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const showDefaultResults = normalizedQuery.length < 2;
  const rankedFiles = [...fileIndex.keys()].sort((a, b) => compareGraphFilePaths(a, b, fileIndex));

  const symbolResults: GraphSymbolSearchResult[] = symbolIds
    .filter((id) => {
      if (showDefaultResults) {
        return true;
      }
      return matchesGraphNodeQuery(normalizedQuery, nodes.get(id) || {}, id);
    })
    .slice(0, symbolLimit)
    .map((id) => {
      const node = nodes.get(id) || {};
      return {
        type: "symbol",
        id,
        label: getGraphNodeLabel(node, id),
        subtitle: getGraphNodeFilePath(node),
        kind: (node.kind || "symbol").toLowerCase(),
      };
    });

  const fileResults: GraphFileSearchResult[] = rankedFiles
    .filter((filePath) => {
      if (showDefaultResults) {
        return true;
      }
      return matchesGraphFileQuery(normalizedQuery, filePath);
    })
    .slice(0, fileLimit)
    .map((filePath) => {
      const symbolCount = fileIndex.get(filePath)?.length ?? 0;
      return {
        type: "file",
        id: filePath,
        label: filePath,
        subtitle: `${symbolCount} symbol${symbolCount === 1 ? "" : "s"}`,
        kind: "file",
        symbolCount,
      };
    });

  return [...symbolResults, ...fileResults];
}
