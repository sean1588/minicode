export interface GraphSelectionEdgeLike {
  source: string;
  target: string;
  kind: string;
}

export function buildGraphEdgeId(edge: GraphSelectionEdgeLike): string {
  return `${edge.source}->${edge.target}:${edge.kind}`;
}

export function buildGraphEdgeIndex<T extends GraphSelectionEdgeLike>(
  edges: readonly T[],
): Map<string, T[]> {
  const edgeIndex = new Map<string, T[]>();

  for (const edge of edges) {
    const sourceEdges = edgeIndex.get(edge.source);
    if (sourceEdges) {
      sourceEdges.push(edge);
    } else {
      edgeIndex.set(edge.source, [edge]);
    }

    const targetEdges = edgeIndex.get(edge.target);
    if (targetEdges) {
      targetEdges.push(edge);
    } else {
      edgeIndex.set(edge.target, [edge]);
    }
  }

  return edgeIndex;
}

interface BuildFileFocusedSelectionOptions<T extends GraphSelectionEdgeLike> {
  filePath: string;
  fileIndex: ReadonlyMap<string, readonly string[]>;
  edgeIndex: ReadonlyMap<string, readonly T[]>;
}

export function buildFileFocusedSelection<T extends GraphSelectionEdgeLike>({
  filePath,
  fileIndex,
  edgeIndex,
}: BuildFileFocusedSelectionOptions<T>): {
  nodeIds: string[];
  edges: T[];
} {
  const fileSymbolIds = fileIndex.get(filePath) || [];
  const nodeIds = new Set<string>();
  const edges = new Map<string, T>();

  for (const symbolId of fileSymbolIds) {
    nodeIds.add(symbolId);

    for (const edge of edgeIndex.get(symbolId) || []) {
      nodeIds.add(edge.source);
      nodeIds.add(edge.target);
      edges.set(buildGraphEdgeId(edge), edge);
    }
  }

  return {
    nodeIds: [...nodeIds],
    edges: [...edges.values()],
  };
}
