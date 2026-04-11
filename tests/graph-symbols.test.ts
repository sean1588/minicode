import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareGraphNodeIds,
  getGraphNodeLabel,
  matchesGraphNodeQuery,
  resolveGraphNodeIds,
} from "../src/shared/graph-symbols.js";

test("getGraphNodeLabel prefers display names for graph collisions", () => {
  assert.equal(
    getGraphNodeLabel({ name: "Review (class)", qualifiedName: "Review#class" }),
    "Review (class)",
  );
  assert.equal(
    getGraphNodeLabel({ qualifiedName: "Session.trim" }),
    "trim",
  );
});

test("resolveGraphNodeIds returns all exact bare-name collisions", () => {
  const nodes = new Map([
    ["Review#type", { name: "Review (type)", qualifiedName: "Review#type", exported: true }],
    ["Review#class", { name: "Review (class)", qualifiedName: "Review#class", exported: true }],
    ["Review.constructor", { name: "Review.constructor", qualifiedName: "Review.constructor", exported: false }],
  ]);

  assert.deepEqual(resolveGraphNodeIds(nodes, "Review"), [
    "Review#class",
    "Review#type",
  ]);
  assert.deepEqual(resolveGraphNodeIds(nodes, "Review (class)"), [
    "Review#class",
  ]);
  assert.deepEqual(resolveGraphNodeIds(nodes, "Review#type"), [
    "Review#type",
  ]);
});

test("matchesGraphNodeQuery supports disambiguated labels and bare collision names", () => {
  const typeNode = { name: "Review (type)", qualifiedName: "Review#type" };
  const classNode = { name: "Review (class)", qualifiedName: "Review#class" };

  assert.equal(matchesGraphNodeQuery("Review", typeNode, "Review#type"), true);
  assert.equal(matchesGraphNodeQuery("Review", classNode, "Review#class"), true);
  assert.equal(matchesGraphNodeQuery("class", classNode, "Review#class"), true);
  assert.equal(matchesGraphNodeQuery("type", classNode, "Review#class"), false);
});

test("compareGraphNodeIds sorts exported collisions by label", () => {
  const nodes = new Map([
    ["Review#type", { name: "Review (type)", qualifiedName: "Review#type", exported: true }],
    ["Review#class", { name: "Review (class)", qualifiedName: "Review#class", exported: true }],
    ["internalReviewHelper", { name: "internalReviewHelper", qualifiedName: "internalReviewHelper", exported: false }],
  ]);

  const sorted = [...nodes.keys()].sort((a, b) => compareGraphNodeIds(a, b, nodes));

  assert.deepEqual(sorted, [
    "Review#class",
    "Review#type",
    "internalReviewHelper",
  ]);
});
