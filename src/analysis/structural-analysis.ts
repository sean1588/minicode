import type { DependencyEdge, IndexedSymbol, ProjectIndex } from "../indexer/types.js";

export type StructuralFindingType =
  | "cycle"
  | "fanInOutlier"
  | "fanOutOutlier"
  | "hotspot"
  | "fileCoupling";

export type StructuralFindingSeverity = "info" | "warning" | "high";

export interface StructuralFinding {
  id: string;
  type: StructuralFindingType;
  severity: StructuralFindingSeverity;
  title: string;
  summary: string;
  symbols: string[];
  files: string[];
  metrics: Record<string, number | string | boolean>;
  rationale: string[];
}

export interface StructuralSymbolMetric {
  qualifiedName: string;
  name: string;
  kind: string;
  filePath: string;
  spanLines: number;
  fanIn: number;
  fanOut: number;
  totalDegree: number;
  inboundKinds: string[];
  outboundKinds: string[];
}

export interface StructuralFileMetric {
  filePath: string;
  symbolCount: number;
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  internalEdgeCount: number;
  afferentCoupling: number;
  efferentCoupling: number;
  totalCoupling: number;
  instability: number;
}

export interface StructuralAnalysisThresholds {
  fanIn: number;
  fanOut: number;
  hotspot: number;
  fileCoupling: number;
}

export interface StructuralAnalysisSummary {
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  findingCount: number;
  cycleCount: number;
  hotspotCount: number;
  thresholds: StructuralAnalysisThresholds;
}

export interface StructuralAnalysisReport {
  version: 1;
  findings: StructuralFinding[];
  symbolMetrics: StructuralSymbolMetric[];
  fileMetrics: StructuralFileMetric[];
  summary: StructuralAnalysisSummary;
}

interface FileCouplingAccumulator {
  filePath: string;
  symbolCount: number;
  incomingEdgeCount: number;
  outgoingEdgeCount: number;
  internalEdgeCount: number;
  inboundFiles: Set<string>;
  outboundFiles: Set<string>;
}

function quantile(values: number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * percentile)));
  return sorted[position] ?? 0;
}

function thresholdFor(values: number[], minimum: number, percentile = 0.9): number {
  const activeValues = values.filter((value) => value > 0);
  return Math.max(minimum, Math.ceil(quantile(activeValues, percentile)));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function buildAdjacencyFrom(edges: DependencyEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.from);
    if (list) {
      list.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
  }
  return adjacency;
}

function findStronglyConnectedComponents(
  symbols: Map<string, IndexedSymbol>,
  edges: DependencyEdge[],
): string[][] {
  const adjacency = buildAdjacencyFrom(edges);
  const indexByNode = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let currentIndex = 0;

  function strongConnect(node: string): void {
    indexByNode.set(node, currentIndex);
    lowLink.set(node, currentIndex);
    currentIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of adjacency.get(node) ?? []) {
      if (!symbols.has(next)) continue;

      if (!indexByNode.has(next)) {
        strongConnect(next);
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, indexByNode.get(next) ?? 0));
      }
    }

    if ((lowLink.get(node) ?? -1) !== (indexByNode.get(node) ?? -2)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const popped = stack.pop()!;
      onStack.delete(popped);
      component.push(popped);
      if (popped === node) break;
    }
    components.push(component.sort((a, b) => a.localeCompare(b)));
  }

  for (const node of symbols.keys()) {
    if (!indexByNode.has(node)) {
      strongConnect(node);
    }
  }

  return components;
}

function severityRank(severity: StructuralFindingSeverity): number {
  switch (severity) {
    case "high":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

function compareFindings(a: StructuralFinding, b: StructuralFinding): number {
  const severityDiff = severityRank(a.severity) - severityRank(b.severity);
  if (severityDiff !== 0) return severityDiff;

  const metricA = Number(a.metrics.score ?? a.metrics.totalDegree ?? a.metrics.cycleSize ?? a.metrics.totalCoupling ?? 0);
  const metricB = Number(b.metrics.score ?? b.metrics.totalDegree ?? b.metrics.cycleSize ?? b.metrics.totalCoupling ?? 0);
  if (metricB !== metricA) return metricB - metricA;

  return a.title.localeCompare(b.title);
}

function shouldSuppressSymbolFinding(metric: StructuralSymbolMetric): boolean {
  return metric.kind === "interface" || metric.kind === "type";
}

function isSmallCompositionRootSymbol(metric: StructuralSymbolMetric): boolean {
  return (
    (metric.kind === "function" || metric.kind === "method") &&
    metric.spanLines <= 40 &&
    metric.fanIn <= 3 &&
    metric.fanOut >= 8
  );
}

function isContractModule(
  fileSymbols: IndexedSymbol[],
  fileMetric: StructuralFileMetric,
): boolean {
  return (
    fileSymbols.length > 0 &&
    fileMetric.efferentCoupling === 0 &&
    fileSymbols.every((symbol) => symbol.kind === "interface" || symbol.kind === "type")
  );
}

function isCompositionRootFile(
  fileSymbols: IndexedSymbol[],
  fileMetric: StructuralFileMetric,
): boolean {
  const hasConcreteRuntimeSymbol = fileSymbols.some((symbol) =>
    symbol.kind === "function" ||
    symbol.kind === "class" ||
    symbol.kind === "method" ||
    symbol.kind === "variable"
  );

  return (
    hasConcreteRuntimeSymbol &&
    fileMetric.symbolCount <= 6 &&
    fileMetric.afferentCoupling <= 3 &&
    fileMetric.instability >= 0.8
  );
}

export function analyzeProjectStructure(projectIndex: ProjectIndex): StructuralAnalysisReport {
  const symbols = [...projectIndex.symbols.values()].sort((a, b) =>
    a.qualifiedName.localeCompare(b.qualifiedName),
  );
  const symbolMap = new Map(symbols.map((symbol) => [symbol.qualifiedName, symbol]));
  const edges = projectIndex.dependencyEdges.filter(
    (edge) => symbolMap.has(edge.from) && symbolMap.has(edge.to),
  );

  const inbound = new Map<string, DependencyEdge[]>();
  const outbound = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const outList = outbound.get(edge.from);
    if (outList) {
      outList.push(edge);
    } else {
      outbound.set(edge.from, [edge]);
    }

    const inList = inbound.get(edge.to);
    if (inList) {
      inList.push(edge);
    } else {
      inbound.set(edge.to, [edge]);
    }
  }

  const symbolMetrics: StructuralSymbolMetric[] = symbols.map((symbol) => {
    const incoming = inbound.get(symbol.qualifiedName) ?? [];
    const outgoing = outbound.get(symbol.qualifiedName) ?? [];
    return {
      qualifiedName: symbol.qualifiedName,
      name: symbol.name,
      kind: symbol.kind,
      filePath: symbol.filePath,
      spanLines: Math.max(1, symbol.endLine - symbol.startLine + 1),
      fanIn: incoming.length,
      fanOut: outgoing.length,
      totalDegree: incoming.length + outgoing.length,
      inboundKinds: uniqueSorted(incoming.map((edge) => edge.kind)),
      outboundKinds: uniqueSorted(outgoing.map((edge) => edge.kind)),
    };
  });

  const fileAccumulators = new Map<string, FileCouplingAccumulator>();
  for (const symbol of symbols) {
    const existing = fileAccumulators.get(symbol.filePath);
    if (existing) {
      existing.symbolCount += 1;
    } else {
      fileAccumulators.set(symbol.filePath, {
        filePath: symbol.filePath,
        symbolCount: 1,
        incomingEdgeCount: 0,
        outgoingEdgeCount: 0,
        internalEdgeCount: 0,
        inboundFiles: new Set(),
        outboundFiles: new Set(),
      });
    }
  }

  for (const edge of edges) {
    const fromSymbol = symbolMap.get(edge.from);
    const toSymbol = symbolMap.get(edge.to);
    if (!fromSymbol || !toSymbol) continue;

    const fromFile = fileAccumulators.get(fromSymbol.filePath);
    const toFile = fileAccumulators.get(toSymbol.filePath);
    if (!fromFile || !toFile) continue;

    fromFile.outgoingEdgeCount += 1;
    toFile.incomingEdgeCount += 1;

    if (fromSymbol.filePath === toSymbol.filePath) {
      fromFile.internalEdgeCount += 1;
      continue;
    }

    fromFile.outboundFiles.add(toSymbol.filePath);
    toFile.inboundFiles.add(fromSymbol.filePath);
  }

  const fileMetrics: StructuralFileMetric[] = [...fileAccumulators.values()]
    .map((fileMetric) => {
      const afferentCoupling = fileMetric.inboundFiles.size;
      const efferentCoupling = fileMetric.outboundFiles.size;
      const totalCoupling = afferentCoupling + efferentCoupling;
      const denominator = afferentCoupling + efferentCoupling;
      const instability = denominator === 0 ? 0 : Number((efferentCoupling / denominator).toFixed(3));

      return {
        filePath: fileMetric.filePath,
        symbolCount: fileMetric.symbolCount,
        incomingEdgeCount: fileMetric.incomingEdgeCount,
        outgoingEdgeCount: fileMetric.outgoingEdgeCount,
        internalEdgeCount: fileMetric.internalEdgeCount,
        afferentCoupling,
        efferentCoupling,
        totalCoupling,
        instability,
      };
    })
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  const thresholds: StructuralAnalysisThresholds = {
    fanIn: thresholdFor(symbolMetrics.map((metric) => metric.fanIn), 3, 0.98),
    fanOut: thresholdFor(symbolMetrics.map((metric) => metric.fanOut), 3, 0.98),
    hotspot: thresholdFor(symbolMetrics.map((metric) => metric.totalDegree), 4, 0.99),
    fileCoupling: thresholdFor(fileMetrics.map((metric) => metric.totalCoupling), 3, 0.95),
  };
  const fileSymbolsByPath = new Map<string, IndexedSymbol[]>();
  for (const symbol of symbols) {
    const list = fileSymbolsByPath.get(symbol.filePath);
    if (list) {
      list.push(symbol);
    } else {
      fileSymbolsByPath.set(symbol.filePath, [symbol]);
    }
  }

  const findings: StructuralFinding[] = [];
  const components = findStronglyConnectedComponents(symbolMap, edges);
  for (const component of components) {
    const componentSet = new Set(component);
    const cycleEdges = edges.filter(
      (edge) => componentSet.has(edge.from) && componentSet.has(edge.to),
    );
    if (component.length < 2) {
      continue;
    }

    const files = uniqueSorted(
      component
        .map((qualifiedName) => symbolMap.get(qualifiedName)?.filePath)
        .filter((value): value is string => Boolean(value)),
    );
    findings.push({
      id: `cycle:${component.join("->")}`,
      type: "cycle",
      severity: component.length >= 3 ? "high" : "warning",
      title: `Cycle across ${component.length} symbols`,
      summary: `${component.length} symbols participate in a strongly connected component.`,
      symbols: component,
      files,
      metrics: {
        cycleSize: component.length,
        edgeCount: cycleEdges.length,
        fileCount: files.length,
      },
      rationale: [
        "Strongly connected component detected using deterministic cycle analysis.",
        `Cycle includes ${cycleEdges.length} internal dependency edges across ${files.length} file(s).`,
      ],
    });
  }

  for (const metric of symbolMetrics) {
    if (shouldSuppressSymbolFinding(metric) || isSmallCompositionRootSymbol(metric)) {
      continue;
    }

    const isHotspot = metric.totalDegree >= thresholds.hotspot && metric.totalDegree > 0;

    if (!isHotspot && metric.fanIn >= thresholds.fanIn && metric.fanIn > 0) {
      findings.push({
        id: `fanin:${metric.qualifiedName}`,
        type: "fanInOutlier",
        severity: metric.fanIn >= thresholds.hotspot ? "warning" : "info",
        title: `${metric.qualifiedName} has unusually high fan-in`,
        summary: `${metric.qualifiedName} is referenced by ${metric.fanIn} inbound dependencies.`,
        symbols: [metric.qualifiedName],
        files: [metric.filePath],
        metrics: {
          fanIn: metric.fanIn,
          threshold: thresholds.fanIn,
        },
        rationale: [
          `Inbound dependency count (${metric.fanIn}) meets or exceeds the current fan-in threshold (${thresholds.fanIn}).`,
          "High fan-in can indicate a central dependency or change hotspot.",
        ],
      });
    }

    if (!isHotspot && metric.fanOut >= thresholds.fanOut && metric.fanOut > 0) {
      findings.push({
        id: `fanout:${metric.qualifiedName}`,
        type: "fanOutOutlier",
        severity: metric.fanOut >= thresholds.hotspot ? "warning" : "info",
        title: `${metric.qualifiedName} has unusually high fan-out`,
        summary: `${metric.qualifiedName} depends on ${metric.fanOut} outbound symbols.`,
        symbols: [metric.qualifiedName],
        files: [metric.filePath],
        metrics: {
          fanOut: metric.fanOut,
          threshold: thresholds.fanOut,
        },
        rationale: [
          `Outbound dependency count (${metric.fanOut}) meets or exceeds the current fan-out threshold (${thresholds.fanOut}).`,
          "High fan-out can indicate orchestration logic or a symbol with broad coupling.",
        ],
      });
    }

    if (isHotspot) {
      findings.push({
        id: `hotspot:${metric.qualifiedName}`,
        type: "hotspot",
        severity: metric.totalDegree >= thresholds.hotspot + 2 ? "warning" : "info",
        title: `${metric.qualifiedName} is a structural hotspot`,
        summary: `${metric.qualifiedName} has total degree ${metric.totalDegree} (${metric.fanIn} in / ${metric.fanOut} out).`,
        symbols: [metric.qualifiedName],
        files: [metric.filePath],
        metrics: {
          totalDegree: metric.totalDegree,
          fanIn: metric.fanIn,
          fanOut: metric.fanOut,
          threshold: thresholds.hotspot,
          score: metric.totalDegree,
        },
        rationale: [
          `Total graph degree (${metric.totalDegree}) meets or exceeds the hotspot threshold (${thresholds.hotspot}).`,
          "High total degree suggests a node that concentrates incoming and outgoing dependencies.",
        ],
      });
    }
  }

  for (const metric of fileMetrics) {
    if (metric.totalCoupling < thresholds.fileCoupling || metric.totalCoupling === 0) {
      continue;
    }

    const fileSymbolEntries = fileSymbolsByPath.get(metric.filePath) ?? [];
    if (
      isContractModule(fileSymbolEntries, metric) ||
      isCompositionRootFile(fileSymbolEntries, metric)
    ) {
      continue;
    }

    const fileSymbols = fileSymbolEntries.map((symbol) => symbol.qualifiedName);
    findings.push({
      id: `file-coupling:${metric.filePath}`,
      type: "fileCoupling",
      severity: metric.totalCoupling >= thresholds.fileCoupling + 2 ? "warning" : "info",
      title: `${metric.filePath} has elevated file-level coupling`,
      summary: `${metric.filePath} has afferent coupling ${metric.afferentCoupling}, efferent coupling ${metric.efferentCoupling}, and instability ${metric.instability}.`,
      symbols: fileSymbols,
      files: [metric.filePath],
      metrics: {
        afferentCoupling: metric.afferentCoupling,
        efferentCoupling: metric.efferentCoupling,
        totalCoupling: metric.totalCoupling,
        instability: metric.instability,
        threshold: thresholds.fileCoupling,
        score: metric.totalCoupling,
      },
      rationale: [
        `Distinct file coupling count (${metric.totalCoupling}) meets or exceeds the file-coupling threshold (${thresholds.fileCoupling}).`,
        "Instability is computed as efferent / (afferent + efferent) using cross-file edges only.",
      ],
    });
  }

  findings.sort(compareFindings);

  return {
    version: 1,
    findings,
    symbolMetrics: [...symbolMetrics].sort((a, b) => {
      if (b.totalDegree !== a.totalDegree) return b.totalDegree - a.totalDegree;
      return a.qualifiedName.localeCompare(b.qualifiedName);
    }),
    fileMetrics: [...fileMetrics].sort((a, b) => {
      if (b.totalCoupling !== a.totalCoupling) return b.totalCoupling - a.totalCoupling;
      return a.filePath.localeCompare(b.filePath);
    }),
    summary: {
      symbolCount: symbolMetrics.length,
      edgeCount: edges.length,
      fileCount: fileMetrics.length,
      findingCount: findings.length,
      cycleCount: findings.filter((finding) => finding.type === "cycle").length,
      hotspotCount: findings.filter((finding) => finding.type === "hotspot").length,
      thresholds,
    },
  };
}
