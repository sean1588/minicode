import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFindingGraphContext,
  buildFindingMetricChips,
  countFindingsByType,
  findingTypeLabel,
  type StructuralFinding,
} from "../src/web/analysis-helpers.js";

test("buildFindingGraphContext limits cycle highlights to internal cycle edges", () => {
  const finding: StructuralFinding = {
    id: "cycle:alpha->beta",
    type: "cycle",
    severity: "warning",
    title: "Cycle across 2 symbols",
    summary: "alpha and beta are mutually dependent.",
    symbols: ["alpha", "beta"],
    files: ["src/a.ts", "src/b.ts"],
    metrics: { cycleSize: 2, edgeCount: 2, fileCount: 2 },
    rationale: ["Strongly connected component detected."],
  };

  const context = buildFindingGraphContext(finding, [
    { source: "alpha", target: "beta", kind: "calls" },
    { source: "beta", target: "alpha", kind: "calls" },
    { source: "alpha", target: "gamma", kind: "calls" },
  ]);

  assert.deepEqual(context.nodes, ["alpha", "beta"]);
  assert.deepEqual(context.edgeIds, [
    "alpha->beta:calls",
    "beta->alpha:calls",
  ]);
});

test("buildFindingGraphContext includes incident edges for hotspot-style findings", () => {
  const finding: StructuralFinding = {
    id: "hotspot:service",
    type: "hotspot",
    severity: "info",
    title: "service is a structural hotspot",
    summary: "service has total degree 4.",
    symbols: ["service"],
    files: ["src/service.ts"],
    metrics: { totalDegree: 4, fanIn: 1, fanOut: 3, threshold: 4 },
    rationale: ["Total degree exceeds hotspot threshold."],
  };

  const context = buildFindingGraphContext(finding, [
    { source: "entry", target: "service", kind: "calls" },
    { source: "service", target: "repo", kind: "calls" },
    { source: "service", target: "util", kind: "calls" },
    { source: "other", target: "elsewhere", kind: "calls" },
  ]);

  assert.deepEqual(context.nodes, ["service"]);
  assert.deepEqual(context.edgeIds, [
    "entry->service:calls",
    "service->repo:calls",
    "service->util:calls",
  ]);
});

test("analysis helpers summarize types and metrics for rendering", () => {
  const findings: StructuralFinding[] = [
    {
      id: "fanin:util",
      type: "fanInOutlier",
      severity: "info",
      title: "util has high fan-in",
      summary: "util is widely referenced.",
      symbols: ["util"],
      files: ["src/util.ts"],
      metrics: { fanIn: 5, threshold: 3 },
      rationale: [],
    },
    {
      id: "file:service",
      type: "fileCoupling",
      severity: "warning",
      title: "service.ts is highly coupled",
      summary: "service.ts has high afferent/efferent coupling.",
      symbols: ["service"],
      files: ["src/service.ts"],
      metrics: { totalCoupling: 4, instability: 0.75 },
      rationale: [],
    },
  ];

  assert.deepEqual(countFindingsByType(findings), {
    cycle: 0,
    fanInOutlier: 1,
    fanOutOutlier: 0,
    hotspot: 0,
    fileCoupling: 1,
  });
  assert.deepEqual(buildFindingMetricChips(findings[0]!), ["fan-in 5", "threshold 3"]);
  assert.deepEqual(buildFindingMetricChips(findings[1]!), ["coupling 4", "instability 0.75"]);
  assert.equal(findingTypeLabel("fileCoupling"), "File coupling");
});
