import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFileFocusedSelection,
  buildGraphEdgeId,
  buildGraphEdgeIndex,
} from "../src/shared/graph-selection.js";

test("buildGraphEdgeIndex indexes edges by both source and target", () => {
  const edges = [
    { source: "Review#class", target: "Session.trim", kind: "references" },
    { source: "renderReview", target: "Review#type", kind: "references" },
  ];

  const edgeIndex = buildGraphEdgeIndex(edges);

  assert.deepEqual(edgeIndex.get("Review#class"), [edges[0]]);
  assert.deepEqual(edgeIndex.get("Session.trim"), [edges[0]]);
  assert.deepEqual(edgeIndex.get("renderReview"), [edges[1]]);
  assert.deepEqual(edgeIndex.get("Review#type"), [edges[1]]);
});

test("buildFileFocusedSelection includes file symbols and touching neighbors", () => {
  const fileIndex = new Map<string, string[]>([
    ["src/review.ts", ["Review#class", "Review#type"]],
  ]);
  const edges = [
    { source: "Review#class", target: "Session.trim", kind: "references" },
    { source: "renderReview", target: "Review#type", kind: "references" },
    { source: "Review#class", target: "Review#type", kind: "references" },
  ];

  const selection = buildFileFocusedSelection({
    filePath: "src/review.ts",
    fileIndex,
    edgeIndex: buildGraphEdgeIndex(edges),
  });

  assert.deepEqual(
    new Set(selection.nodeIds),
    new Set(["Review#class", "Review#type", "Session.trim", "renderReview"]),
  );
  assert.deepEqual(
    new Set(selection.edges.map((edge) => buildGraphEdgeId(edge))),
    new Set(edges.map((edge) => buildGraphEdgeId(edge))),
  );
});

test("buildFileFocusedSelection excludes edges between external neighbors", () => {
  const fileIndex = new Map<string, string[]>([
    ["src/review.ts", ["Review#class"]],
  ]);
  const reviewToSession = { source: "Review#class", target: "Session.trim", kind: "references" };
  const reviewToRender = { source: "Review#class", target: "renderReview", kind: "references" };
  const sessionToRender = { source: "Session.trim", target: "renderReview", kind: "references" };
  const edges = [reviewToSession, reviewToRender, sessionToRender];

  const selection = buildFileFocusedSelection({
    filePath: "src/review.ts",
    fileIndex,
    edgeIndex: buildGraphEdgeIndex(edges),
  });

  assert.deepEqual(
    new Set(selection.nodeIds),
    new Set(["Review#class", "Session.trim", "renderReview"]),
  );
  assert.deepEqual(
    new Set(selection.edges.map((edge) => buildGraphEdgeId(edge))),
    new Set([
      buildGraphEdgeId(reviewToSession),
      buildGraphEdgeId(reviewToRender),
    ]),
  );
});

test("buildFileFocusedSelection returns an empty selection for unknown files", () => {
  const selection = buildFileFocusedSelection({
    filePath: "src/missing.ts",
    fileIndex: new Map<string, string[]>(),
    edgeIndex: buildGraphEdgeIndex([]),
  });

  assert.deepEqual(selection, { nodeIds: [], edges: [] });
});
