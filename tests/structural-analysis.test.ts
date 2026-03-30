import assert from "node:assert/strict";
import { test } from "node:test";

import type { DependencyEdge, IndexedSymbol } from "@minicode/agent-sdk";
import { analyzeProjectStructure } from "../src/analysis/structural-analysis.js";
import { createProjectIndex } from "../src/indexer/project-index.js";

function makeSymbol(qualifiedName: string, filePath: string, kind: IndexedSymbol["kind"] = "function"): IndexedSymbol {
  const shortName = qualifiedName.includes(".")
    ? qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)
    : qualifiedName;

  return {
    name: shortName,
    qualifiedName,
    kind,
    filePath,
    startLine: 1,
    endLine: 5,
    signature: `${kind} ${qualifiedName}`,
    exported: true,
    dependencies: [],
  };
}

function buildTestIndex(symbols: IndexedSymbol[], edges: DependencyEdge[]) {
  const symbolMap = new Map<string, IndexedSymbol>();
  const fileMap = new Map<string, IndexedSymbol[]>();

  for (const symbol of symbols) {
    symbolMap.set(symbol.qualifiedName, symbol);
    const list = fileMap.get(symbol.filePath);
    if (list) {
      list.push(symbol);
    } else {
      fileMap.set(symbol.filePath, [symbol]);
    }
  }

  return createProjectIndex(symbolMap, fileMap, edges, [], new Map(), "/tmp/test-workspace");
}

test("analyzeProjectStructure reports cycles, symbol outliers, and file coupling", () => {
  const symbols = [
    makeSymbol("entry", "src/entry.ts"),
    makeSymbol("service", "src/service.ts"),
    makeSymbol("repo", "src/repo.ts"),
    makeSymbol("util", "src/util.ts"),
    makeSymbol("cycleA", "src/cycle.ts"),
    makeSymbol("cycleB", "src/cycle.ts"),
  ];
  const edges: DependencyEdge[] = [
    { from: "entry", to: "service", kind: "calls" },
    { from: "entry", to: "util", kind: "calls" },
    { from: "service", to: "repo", kind: "calls" },
    { from: "service", to: "util", kind: "calls" },
    { from: "service", to: "cycleA", kind: "calls" },
    { from: "repo", to: "util", kind: "calls" },
    { from: "repo", to: "cycleA", kind: "calls" },
    { from: "cycleA", to: "cycleB", kind: "calls" },
    { from: "cycleB", to: "cycleA", kind: "calls" },
  ];

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));

  assert.equal(report.version, 1);
  assert.equal(report.summary.symbolCount, 6);
  assert.equal(report.summary.edgeCount, 9);
  assert.equal(report.summary.fileCount, 5);
  assert.ok(report.summary.findingCount >= 5);
  assert.equal(report.summary.cycleCount, 1);
  assert.equal(report.summary.thresholds.fanIn, 3);
  assert.equal(report.summary.thresholds.fanOut, 3);
  assert.equal(report.summary.thresholds.hotspot, 4);
  assert.equal(report.summary.thresholds.fileCoupling, 4);

  const cycleFinding = report.findings.find((finding) => finding.type === "cycle");
  assert.ok(cycleFinding);
  assert.deepEqual(cycleFinding?.symbols, ["cycleA", "cycleB"]);
  assert.equal(cycleFinding?.severity, "warning");

  const fanInFinding = report.findings.find(
    (finding) => finding.type === "fanInOutlier" && finding.symbols.includes("util"),
  );
  assert.ok(fanInFinding);
  assert.equal(fanInFinding?.metrics.fanIn, 3);

  const fanOutFinding = report.findings.find(
    (finding) => finding.type === "fanOutOutlier" && finding.symbols.includes("service"),
  );
  assert.ok(fanOutFinding);
  assert.equal(fanOutFinding?.metrics.fanOut, 3);

  const hotspotFinding = report.findings.find(
    (finding) => finding.type === "hotspot" && finding.symbols.includes("service"),
  );
  assert.ok(hotspotFinding);
  assert.equal(hotspotFinding?.metrics.totalDegree, 4);

  const fileFinding = report.findings.find(
    (finding) => finding.type === "fileCoupling" && finding.files.includes("src/service.ts"),
  );
  assert.ok(fileFinding);
  assert.equal(fileFinding?.metrics.totalCoupling, 4);
  assert.equal(fileFinding?.metrics.instability, 0.75);

  const serviceMetric = report.symbolMetrics.find((metric) => metric.qualifiedName === "service");
  assert.ok(serviceMetric);
  assert.equal(serviceMetric?.totalDegree, 4);

  const serviceFileMetric = report.fileMetrics.find((metric) => metric.filePath === "src/service.ts");
  assert.ok(serviceFileMetric);
  assert.equal(serviceFileMetric?.totalCoupling, 4);
});

test("analyzeProjectStructure stays empty for disconnected graphs", () => {
  const symbols = [
    makeSymbol("alpha", "src/alpha.ts"),
    makeSymbol("beta", "src/beta.ts"),
  ];
  const report = analyzeProjectStructure(buildTestIndex(symbols, []));

  assert.equal(report.findings.length, 0);
  assert.equal(report.summary.cycleCount, 0);
  assert.equal(report.fileMetrics.length, 2);
  assert.equal(report.symbolMetrics[0]?.totalDegree, 0);
});
