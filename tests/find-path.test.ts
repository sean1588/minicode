import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildProjectIndex, createProjectIndex } from "../src/indexer/project-index.js";
import { createFindPathTool } from "../src/tools/find-path.js";
import type { DependencyEdge, IndexedSymbol } from "../src/indexer/types.js";

function makeSymbol(name: string, kind: "function" | "class" | "method" = "function"): IndexedSymbol {
  return {
    name,
    qualifiedName: name,
    kind,
    filePath: "test.ts",
    startLine: 1,
    endLine: 5,
    signature: `function ${name}()`,
    exported: true,
    dependencies: [],
  };
}

function buildTestIndex(symbols: IndexedSymbol[], edges: DependencyEdge[]) {
  const symMap = new Map<string, IndexedSymbol>();
  const fileMap = new Map<string, IndexedSymbol[]>();
  for (const sym of symbols) {
    symMap.set(sym.qualifiedName, sym);
    const existing = fileMap.get(sym.filePath) ?? [];
    existing.push(sym);
    fileMap.set(sym.filePath, existing);
  }
  return createProjectIndex(symMap, fileMap, edges, [], new Map(), "/tmp/test");
}

test("findPath returns path between two connected symbols", () => {
  const symbols = [makeSymbol("a"), makeSymbol("b"), makeSymbol("c")];
  const edges: DependencyEdge[] = [
    { from: "a", to: "b", kind: "calls" },
    { from: "b", to: "c", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);

  const result = index.findPath("a", "c");
  assert.equal(result.length, 3);
  assert.equal(result[0]!.qualifiedName, "a");
  assert.equal(result[1]!.qualifiedName, "b");
  assert.equal(result[2]!.qualifiedName, "c");
});

test("findPath returns empty array when no path exists", () => {
  const symbols = [makeSymbol("a"), makeSymbol("b")];
  const edges: DependencyEdge[] = [];
  const index = buildTestIndex(symbols, edges);

  const result = index.findPath("a", "b");
  assert.equal(result.length, 0);
});

test("findPath returns direct path for adjacent symbols", () => {
  const symbols = [makeSymbol("a"), makeSymbol("b")];
  const edges: DependencyEdge[] = [{ from: "a", to: "b", kind: "calls" }];
  const index = buildTestIndex(symbols, edges);

  const result = index.findPath("a", "b");
  assert.equal(result.length, 2);
  assert.equal(result[0]!.qualifiedName, "a");
  assert.equal(result[1]!.qualifiedName, "b");
});

test("findPath finds path via reverse edges", () => {
  const symbols = [makeSymbol("a"), makeSymbol("b"), makeSymbol("c")];
  // Only edge is b->a and b->c, so path from a to c goes a<-b->c
  const edges: DependencyEdge[] = [
    { from: "b", to: "a", kind: "calls" },
    { from: "b", to: "c", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);

  const result = index.findPath("a", "c");
  assert.equal(result.length, 3);
  assert.equal(result[0]!.qualifiedName, "a");
  assert.equal(result[1]!.qualifiedName, "b");
  assert.equal(result[2]!.qualifiedName, "c");
});

test("findPath respects maxDepth", () => {
  const symbols = [makeSymbol("a"), makeSymbol("b"), makeSymbol("c"), makeSymbol("d")];
  const edges: DependencyEdge[] = [
    { from: "a", to: "b", kind: "calls" },
    { from: "b", to: "c", kind: "calls" },
    { from: "c", to: "d", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);

  // maxDepth 1 should not find a path from a to d (3 hops away)
  const result = index.findPath("a", "d", 1);
  assert.equal(result.length, 0);

  // maxDepth 3 should find it
  const result2 = index.findPath("a", "d", 3);
  assert.equal(result2.length, 4);
});

test("findPath returns empty for unknown symbols", () => {
  const symbols = [makeSymbol("a")];
  const index = buildTestIndex(symbols, []);

  assert.equal(index.findPath("a", "nonexistent").length, 0);
  assert.equal(index.findPath("nonexistent", "a").length, 0);
});

test("findPathToEntryPoint traces back to entry points", () => {
  const symbols = [makeSymbol("entry"), makeSymbol("middle"), makeSymbol("leaf")];
  const edges: DependencyEdge[] = [
    { from: "entry", to: "middle", kind: "calls" },
    { from: "middle", to: "leaf", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);

  const paths = index.findPathToEntryPoint("leaf");
  assert.ok(paths.length > 0);
  // The path should go from entry -> middle -> leaf
  const firstPath = paths[0]!;
  assert.equal(firstPath[0]!.qualifiedName, "entry");
  assert.equal(firstPath[firstPath.length - 1]!.qualifiedName, "leaf");
});

test("findPathToEntryPoint returns empty for entry point symbols", () => {
  const symbols = [makeSymbol("entry"), makeSymbol("other")];
  const edges: DependencyEdge[] = [
    { from: "entry", to: "other", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);

  // "entry" has no inbound edges, so it IS an entry point
  const paths = index.findPathToEntryPoint("entry");
  // Should return empty or self-referential since it's already an entry point
  assert.equal(paths.length, 0);
});

test("findPathToEntryPoint returns empty for unknown symbols", () => {
  const index = buildTestIndex([], []);
  const paths = index.findPathToEntryPoint("nonexistent");
  assert.equal(paths.length, 0);
});

test("find_path tool returns path between two symbols", async () => {
  const symbols = [makeSymbol("a"), makeSymbol("b"), makeSymbol("c")];
  const edges: DependencyEdge[] = [
    { from: "a", to: "b", kind: "calls" },
    { from: "b", to: "c", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);
  const tool = createFindPathTool(index);

  const result = await tool.execute({ from: "a", to: "c" });
  assert.ok(result.includes("# Path from a to c"));
  assert.ok(result.includes("3 symbols"));
  assert.ok(result.includes("[function] a"));
  assert.ok(result.includes("[function] b"));
  assert.ok(result.includes("[function] c"));
});

test("find_path tool traces to entry points when 'to' is omitted", async () => {
  const symbols = [makeSymbol("entry"), makeSymbol("middle"), makeSymbol("leaf")];
  const edges: DependencyEdge[] = [
    { from: "entry", to: "middle", kind: "calls" },
    { from: "middle", to: "leaf", kind: "calls" },
  ];
  const index = buildTestIndex(symbols, edges);
  const tool = createFindPathTool(index);

  const result = await tool.execute({ from: "leaf" });
  assert.ok(result.includes("Entry point paths for leaf"));
  assert.ok(result.includes("[function] entry"));
});

test("find_path tool returns error for unknown symbol", async () => {
  const index = buildTestIndex([], []);
  const tool = createFindPathTool(index);

  const result = await tool.execute({ from: "nonexistent" });
  assert.ok(result.includes("not found"));
});

test("find_path tool returns error when target symbol not found", async () => {
  const symbols = [makeSymbol("a")];
  const index = buildTestIndex(symbols, []);
  const tool = createFindPathTool(index);

  const result = await tool.execute({ from: "a", to: "nonexistent" });
  assert.ok(result.includes("not found"));
});

test("find_path tool reports no path when symbols are disconnected", async () => {
  const symbols = [makeSymbol("a"), makeSymbol("b")];
  const index = buildTestIndex(symbols, []);
  const tool = createFindPathTool(index);

  const result = await tool.execute({ from: "a", to: "b" });
  assert.ok(result.includes("No path found"));
});

test("find_path tool works with real project index", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createFindPathTool(projectIndex);

  // Find path between two known symbols
  const result = await tool.execute({
    from: "createModelClient",
    to: "AgentConfig",
  });
  assert.ok(result.includes("# Path from createModelClient to AgentConfig"));
  assert.ok(result.includes("symbols"));
});

test("find_path returns disambiguation list for ambiguous bare target symbols", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-find-path-collisions-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export class Review {
  constructor(public id: string) {}
}

export function createReview(id: string) {
  return new Review(id);
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createFindPathTool(projectIndex);

  const result = await tool.execute({ from: "createReview", to: "Review" });

  assert.ok(result.includes('Symbol "Review" is ambiguous'));
  assert.ok(result.includes("Review (type)"));
  assert.ok(result.includes("Review (class)"));
  assert.ok(result.includes("qualified: Review#type"));
  assert.ok(result.includes("qualified: Review#class"));
});

test("find_path accepts qualified names for colliding symbols", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-find-path-qualified-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export class Review {
  constructor(public id: string) {}
}

export function createReview(id: string) {
  return new Review(id);
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createFindPathTool(projectIndex);

  const result = await tool.execute({ from: "createReview", to: "Review#class" });

  assert.ok(result.includes("# Path from createReview to Review (class)"));
  assert.ok(result.includes("[function] createReview"));
  assert.ok(result.includes("[class] Review (class)"));
});
