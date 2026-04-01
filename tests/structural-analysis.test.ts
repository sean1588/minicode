import assert from "node:assert/strict";
import { test } from "node:test";

import type { DependencyEdge, IndexedSymbol } from "@minicode/agent-sdk";
import { analyzeProjectStructure } from "../src/analysis/structural-analysis.js";
import { createProjectIndex } from "../src/indexer/project-index.js";

function makeSymbol(
  qualifiedName: string,
  filePath: string,
  kind: IndexedSymbol["kind"] = "function",
  startLine = 1,
  endLine = 5,
): IndexedSymbol {
  const shortName = qualifiedName.includes(".")
    ? qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)
    : qualifiedName;

  return {
    name: shortName,
    qualifiedName,
    kind,
    filePath,
    startLine,
    endLine,
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

  const hotspotFinding = report.findings.find(
    (finding) => finding.type === "hotspot" && finding.symbols.includes("service"),
  );
  assert.ok(hotspotFinding);
  assert.equal(hotspotFinding?.metrics.totalDegree, 4);
  assert.ok(
    !report.findings.some(
      (finding) => finding.type === "fanOutOutlier" && finding.symbols.includes("service"),
    ),
    "hotspot findings should absorb overlapping fan-out outliers for the same symbol",
  );

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

test("analyzeProjectStructure avoids flagging routine fan-out in skewed graphs", () => {
  const symbols: IndexedSymbol[] = [makeSymbol("sharedUtil", "src/shared.ts")];
  const edges: DependencyEdge[] = [];

  for (let i = 0; i < 40; i += 1) {
    const worker = `worker${i}`;
    symbols.push(makeSymbol(worker, `src/workers/${worker}.ts`));
    edges.push({ from: worker, to: "sharedUtil", kind: "calls" });
  }

  for (let i = 0; i < 5; i += 1) {
    const orchestrator = `orchestrator${i}`;
    symbols.push(makeSymbol(orchestrator, `src/orchestrators/${orchestrator}.ts`, "function", 1, 80));
    for (let j = 0; j < 10; j += 1) {
      const leaf = `${orchestrator}.leaf${j}`;
      symbols.push(makeSymbol(leaf, `src/orchestrators/${orchestrator}.ts`));
      edges.push({ from: orchestrator, to: leaf, kind: "calls" });
    }
  }

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));

  assert.equal(report.summary.thresholds.fanOut, 10);

  const fanOutFindings = report.findings.filter((finding) => finding.type === "fanOutOutlier");
  assert.equal(fanOutFindings.length, 5);
  assert.ok(fanOutFindings.every((finding) => finding.symbols[0]?.startsWith("orchestrator")));
  assert.ok(report.findings.every((finding) => !finding.symbols.includes("worker0")));
});

test("analyzeProjectStructure keeps fan-out findings for non-hotspot orchestrators", () => {
  const symbols: IndexedSymbol[] = [
    makeSymbol("orchestrator", "src/orchestrator.ts", "function", 1, 80),
  ];
  const edges: DependencyEdge[] = [];

  for (let i = 0; i < 3; i += 1) {
    const shared = `shared${i}`;
    symbols.push(makeSymbol(shared, `src/shared/${shared}.ts`));
    edges.push({ from: "orchestrator", to: shared, kind: "calls" });
  }

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));
  const fanOutFinding = report.findings.find(
    (finding) => finding.type === "fanOutOutlier" && finding.symbols.includes("orchestrator"),
  );

  assert.ok(fanOutFinding, "high fan-out should still surface when the symbol is not also a hotspot");
  assert.ok(
    !report.findings.some(
      (finding) => finding.type === "hotspot" && finding.symbols.includes("orchestrator"),
    ),
    "fan-out only orchestrators should not be forced into hotspot findings",
  );
});

test("analyzeProjectStructure ignores self-recursive loops and suppresses shared type hubs", () => {
  const symbols = [
    makeSymbol("SharedConfig", "src/types.ts", "interface"),
    makeSymbol("loadConfig", "src/load.ts"),
    makeSymbol("saveConfig", "src/save.ts"),
    makeSymbol("runConfigFlow", "src/flow.ts"),
    makeSymbol("walk", "src/walk.ts"),
  ];
  const edges: DependencyEdge[] = [
    { from: "loadConfig", to: "SharedConfig", kind: "references" },
    { from: "saveConfig", to: "SharedConfig", kind: "references" },
    { from: "runConfigFlow", to: "SharedConfig", kind: "references" },
    { from: "walk", to: "walk", kind: "calls" },
  ];

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));

  assert.ok(!report.findings.some((finding) => finding.type === "cycle"), "self-recursion should not surface as a cycle finding");
  assert.ok(
    !report.findings.some(
      (finding) => finding.type !== "fileCoupling" && finding.symbols.includes("SharedConfig"),
    ),
    "shared type/interface hubs should not produce symbol-level findings by default",
  );
});

test("analyzeProjectStructure suppresses contract modules and composition roots at the file level", () => {
  const symbols = [
    makeSymbol("SharedConfig", "src/types.ts", "interface"),
    makeSymbol("SharedEvent", "src/types.ts", "type"),
    makeSymbol("loadConfig", "src/load.ts"),
    makeSymbol("saveConfig", "src/save.ts"),
    makeSymbol("runWorkflow", "src/run.ts"),
    makeSymbol("auditWorkflow", "src/audit.ts"),
    makeSymbol("bridgeRuntime", "src/bridge.ts"),
    makeSymbol("buildShell", "src/bootstrap.ts"),
    makeSymbol("helperA", "src/helpers/a.ts"),
    makeSymbol("helperB", "src/helpers/b.ts"),
    makeSymbol("helperC", "src/helpers/c.ts"),
    makeSymbol("helperD", "src/helpers/d.ts"),
  ];
  const edges: DependencyEdge[] = [
    { from: "loadConfig", to: "SharedConfig", kind: "references" },
    { from: "saveConfig", to: "SharedConfig", kind: "references" },
    { from: "runWorkflow", to: "SharedConfig", kind: "references" },
    { from: "auditWorkflow", to: "SharedEvent", kind: "references" },
    { from: "loadConfig", to: "bridgeRuntime", kind: "calls" },
    { from: "saveConfig", to: "bridgeRuntime", kind: "calls" },
    { from: "bridgeRuntime", to: "helperA", kind: "calls" },
    { from: "bridgeRuntime", to: "helperB", kind: "calls" },
    { from: "buildShell", to: "helperA", kind: "calls" },
    { from: "buildShell", to: "helperB", kind: "calls" },
    { from: "buildShell", to: "helperC", kind: "calls" },
    { from: "buildShell", to: "helperD", kind: "calls" },
  ];

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));
  const fileCouplingFiles = report.findings
    .filter((finding) => finding.type === "fileCoupling")
    .flatMap((finding) => finding.files);

  assert.ok(
    !fileCouplingFiles.includes("src/types.ts"),
    "pure contract modules should not surface as file-coupling smells",
  );
  assert.ok(
    !fileCouplingFiles.includes("src/bootstrap.ts"),
    "obvious composition roots should not surface as file-coupling smells",
  );
  assert.ok(
    fileCouplingFiles.includes("src/bridge.ts"),
    "runtime bridge files with meaningful inbound and outbound coupling should still surface",
  );
});

test("analyzeProjectStructure suppresses small composition-root hotspot symbols but keeps long orchestrators", () => {
  const symbols = [
    makeSymbol("composeTools", "src/registry.ts", "function", 1, 28),
    makeSymbol("runRuntime", "src/runtime.ts", "function", 1, 120),
  ];
  const edges: DependencyEdge[] = [];

  for (let i = 0; i < 3; i += 1) {
    const caller = `caller${i}`;
    symbols.push(makeSymbol(caller, `src/callers/${caller}.ts`));
    edges.push({ from: caller, to: "composeTools", kind: "calls" });
  }

  for (let i = 0; i < 12; i += 1) {
    const dep = `dep${i}`;
    symbols.push(makeSymbol(dep, `src/deps/${dep}.ts`));
    edges.push({ from: "composeTools", to: dep, kind: "calls" });
  }

  for (let i = 0; i < 16; i += 1) {
    const dep = `runtimeDep${i}`;
    symbols.push(makeSymbol(dep, `src/runtime/deps/${dep}.ts`));
    edges.push({ from: "runRuntime", to: dep, kind: "calls" });
  }

  const report = analyzeProjectStructure(buildTestIndex(symbols, edges));

  assert.ok(
    !report.findings.some((finding) => finding.symbols.includes("composeTools")),
    "small composition-root helpers should not surface as structural outliers by default",
  );
  assert.ok(
    report.findings.some((finding) => finding.symbols.includes("runRuntime")),
    "long orchestrators should still surface when they fan out broadly",
  );
});
