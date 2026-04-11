export interface GraphSymbolNodeLike {
  id?: string;
  qualifiedName?: string;
  name?: string;
  exported?: boolean;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function stripCollisionSuffix(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function stripDisplayKindSuffix(value: string): string {
  return value.replace(/\s+\([^()]+\)$/, "");
}

export function getGraphNodeId(node: GraphSymbolNodeLike, fallbackId = ""): string {
  return node.qualifiedName || node.id || fallbackId || node.name || "";
}

export function getGraphNodeLabel(node: GraphSymbolNodeLike, fallbackId = ""): string {
  const label = node.name?.trim();
  if (label && label.length > 0) {
    return label;
  }

  const id = getGraphNodeId(node, fallbackId);
  return id.split(".").pop() || id;
}

export function getGraphNodeAliases(node: GraphSymbolNodeLike, fallbackId = ""): string[] {
  const id = getGraphNodeId(node, fallbackId);
  const label = getGraphNodeLabel(node, fallbackId);
  const shortId = id.split(".").pop() || id;

  return dedupe([
    id,
    node.id ?? "",
    node.qualifiedName ?? "",
    label,
    stripDisplayKindSuffix(label),
    shortId,
    stripCollisionSuffix(shortId),
    stripCollisionSuffix(id),
  ]);
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

export function compareGraphNodeIds(
  a: string,
  b: string,
  nodes: ReadonlyMap<string, GraphSymbolNodeLike>,
): number {
  const nodeA = nodes.get(a);
  const nodeB = nodes.get(b);
  const exportedA = nodeA ? Number(!!nodeA.exported) : 0;
  const exportedB = nodeB ? Number(!!nodeB.exported) : 0;
  if (exportedA !== exportedB) {
    return exportedB - exportedA;
  }

  const labelA = getGraphNodeLabel(nodeA ?? {}, a);
  const labelB = getGraphNodeLabel(nodeB ?? {}, b);
  const labelComparison = compareLabels(labelA, labelB);
  if (labelComparison !== 0) {
    return labelComparison;
  }

  return compareLabels(a, b);
}

export function matchesGraphNodeQuery(
  query: string,
  node: GraphSymbolNodeLike,
  fallbackId = "",
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return false;
  }

  return getGraphNodeAliases(node, fallbackId).some((alias) =>
    alias.toLowerCase().includes(normalizedQuery),
  );
}

export function resolveGraphNodeIds(
  nodes: ReadonlyMap<string, GraphSymbolNodeLike>,
  symbolName: string,
): string[] {
  const query = symbolName.trim();
  if (query.length === 0) {
    return [];
  }

  if (nodes.has(query)) {
    return [query];
  }

  const exactMatches = [...nodes.entries()]
    .filter(([id, node]) => getGraphNodeAliases(node, id).includes(query))
    .map(([id]) => id)
    .sort((a, b) => compareGraphNodeIds(a, b, nodes));
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  return [...nodes.entries()]
    .filter(([id, node]) => matchesGraphNodeQuery(query, node, id))
    .map(([id]) => id)
    .sort((a, b) => compareGraphNodeIds(a, b, nodes));
}
