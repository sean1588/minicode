import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGraphFileIndex,
  buildGraphSearchResults,
  compareGraphFilePaths,
  matchesGraphFileQuery,
} from "../src/shared/graph-search.js";

test("buildGraphFileIndex groups graph nodes by file path", () => {
  const nodes = new Map([
    ["Review#class", { name: "Review (class)", qualifiedName: "Review#class", filePath: "src/review.ts", exported: true }],
    ["Review#type", { name: "Review (type)", qualifiedName: "Review#type", filePath: "src/review.ts", exported: true }],
    ["Session.trim", { name: "trim", qualifiedName: "Session.trim", filePath: "src/session.ts", exported: false }],
  ]);

  const fileIndex = buildGraphFileIndex(nodes);

  assert.deepEqual(fileIndex.get("src/review.ts"), ["Review#class", "Review#type"]);
  assert.deepEqual(fileIndex.get("src/session.ts"), ["Session.trim"]);
});

test("compareGraphFilePaths prefers files with more indexed symbols", () => {
  const fileIndex = new Map<string, string[]>([
    ["src/review.ts", ["Review#class", "Review#type"]],
    ["src/session.ts", ["Session.trim"]],
  ]);

  const ranked = [...fileIndex.keys()].sort((a, b) => compareGraphFilePaths(a, b, fileIndex));

  assert.deepEqual(ranked, ["src/review.ts", "src/session.ts"]);
});

test("matchesGraphFileQuery matches file path substrings case-insensitively", () => {
  assert.equal(matchesGraphFileQuery("review", "src/review.ts"), true);
  assert.equal(matchesGraphFileQuery("SRC/REVIEW", "src/review.ts"), true);
  assert.equal(matchesGraphFileQuery("session", "src/review.ts"), false);
});

test("buildGraphSearchResults returns mixed symbol and file matches", () => {
  const nodes = new Map([
    ["Review#class", { name: "Review (class)", qualifiedName: "Review#class", kind: "class", filePath: "src/review.ts", exported: true }],
    ["Review#type", { name: "Review (type)", qualifiedName: "Review#type", kind: "type", filePath: "src/review.ts", exported: true }],
    ["Session.trim", { name: "trim", qualifiedName: "Session.trim", kind: "method", filePath: "src/session.ts", exported: false }],
  ]);
  const rankedSymbols = [...nodes.keys()];
  const fileIndex = buildGraphFileIndex(nodes);

  const results = buildGraphSearchResults({
    query: "review",
    symbolIds: rankedSymbols,
    nodes,
    fileIndex,
  });

  assert.equal(results[0]?.type, "symbol");
  assert.equal(results[0]?.id, "Review#class");
  assert.equal(results[1]?.type, "symbol");
  assert.equal(results[2]?.type, "file");
  assert.equal(results[2]?.id, "src/review.ts");
});

test("buildGraphSearchResults returns default file suggestions for short queries", () => {
  const nodes = new Map([
    ["Review#class", { name: "Review (class)", qualifiedName: "Review#class", kind: "class", filePath: "src/review.ts", exported: true }],
    ["Review#type", { name: "Review (type)", qualifiedName: "Review#type", kind: "type", filePath: "src/review.ts", exported: true }],
    ["Session.trim", { name: "trim", qualifiedName: "Session.trim", kind: "method", filePath: "src/session.ts", exported: false }],
  ]);
  const rankedSymbols = [...nodes.keys()];
  const fileIndex = buildGraphFileIndex(nodes);

  const results = buildGraphSearchResults({
    query: "",
    symbolIds: rankedSymbols,
    nodes,
    fileIndex,
    symbolLimit: 2,
    fileLimit: 1,
  });

  assert.equal(results.length, 3);
  assert.equal(results[2]?.type, "file");
  assert.equal(results[2]?.id, "src/review.ts");
});
