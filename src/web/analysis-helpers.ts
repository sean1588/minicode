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

export interface StructuralAnalysisSummary {
  symbolCount: number;
  edgeCount: number;
  fileCount: number;
  findingCount: number;
  cycleCount: number;
  hotspotCount: number;
  thresholds: {
    fanIn: number;
    fanOut: number;
    hotspot: number;
    fileCoupling: number;
  };
}

export interface StructuralAnalysisReport {
  version: 1;
  findings: StructuralFinding[];
  summary: StructuralAnalysisSummary;
}

export interface GraphEdgeRef {
  source: string;
  target: string;
  kind: string;
}

export interface FindingGraphContext {
  nodes: string[];
  edgeIds: string[];
}

export function findingTypeLabel(type: StructuralFindingType): string {
  switch (type) {
    case "cycle":
      return "Cycle";
    case "fanInOutlier":
      return "High fan-in";
    case "fanOutOutlier":
      return "High fan-out";
    case "hotspot":
      return "Hotspot";
    case "fileCoupling":
      return "File coupling";
  }
}

export function findingSeverityLabel(severity: StructuralFindingSeverity): string {
  switch (severity) {
    case "high":
      return "High";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
  }
}

export function buildFindingMetricChips(finding: StructuralFinding): string[] {
  switch (finding.type) {
    case "cycle":
      return [
        `${Number(finding.metrics.cycleSize ?? finding.symbols.length)} symbols`,
        `${Number(finding.metrics.edgeCount ?? 0)} edges`,
        `${Number(finding.metrics.fileCount ?? finding.files.length)} files`,
      ];
    case "fanInOutlier":
      return [
        `fan-in ${Number(finding.metrics.fanIn ?? 0)}`,
        `threshold ${Number(finding.metrics.threshold ?? 0)}`,
      ];
    case "fanOutOutlier":
      return [
        `fan-out ${Number(finding.metrics.fanOut ?? 0)}`,
        `threshold ${Number(finding.metrics.threshold ?? 0)}`,
      ];
    case "hotspot":
      return [
        `degree ${Number(finding.metrics.totalDegree ?? 0)}`,
        `${Number(finding.metrics.fanIn ?? 0)} in`,
        `${Number(finding.metrics.fanOut ?? 0)} out`,
      ];
    case "fileCoupling":
      return [
        `coupling ${Number(finding.metrics.totalCoupling ?? 0)}`,
        `instability ${Number(finding.metrics.instability ?? 0)}`,
      ];
  }
}

export function buildFindingGraphContext(
  finding: StructuralFinding,
  edges: GraphEdgeRef[],
): FindingGraphContext {
  const selectedSymbols = new Set(finding.symbols);
  const edgeIds = new Set<string>();

  for (const edge of edges) {
    const touchesSelected = selectedSymbols.has(edge.source) || selectedSymbols.has(edge.target);
    const internalToSelection = selectedSymbols.has(edge.source) && selectedSymbols.has(edge.target);

    if (
      (finding.type === "cycle" && internalToSelection) ||
      (finding.type !== "cycle" && touchesSelected)
    ) {
      edgeIds.add(`${edge.source}->${edge.target}:${edge.kind}`);
    }
  }

  return {
    nodes: [...selectedSymbols].sort((a, b) => a.localeCompare(b)),
    edgeIds: [...edgeIds].sort((a, b) => a.localeCompare(b)),
  };
}

export function countFindingsByType(findings: StructuralFinding[]): Record<StructuralFindingType, number> {
  return findings.reduce<Record<StructuralFindingType, number>>(
    (counts, finding) => {
      counts[finding.type] += 1;
      return counts;
    },
    {
      cycle: 0,
      fanInOutlier: 0,
      fanOutOutlier: 0,
      hotspot: 0,
      fileCoupling: 0,
    },
  );
}
