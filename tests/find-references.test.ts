import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createFindReferencesTool } from "../src/tools/find-references.js";

test("find_references returns symbols that reference ProjectIndex", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createFindReferencesTool(projectIndex);

  const result = await tool.execute({ name: "ProjectIndex" });

  assert.ok(result.includes("# References to ProjectIndex"));
  assert.ok(result.includes("createToolRegistry") || result.includes("createReadSymbolTool"));
});

test("find_references returns error for unknown symbol", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createFindReferencesTool(projectIndex);

  const result = await tool.execute({ name: "NonExistentSymbol" });

  assert.ok(result.includes("not found"));
});

test("find_references appears in tool registry when projectIndex provided", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const { createToolRegistry } = await import("../src/tools/registry.js");
  const { createTestAgentConfig } = await import("./test-utils.js");
  const registry = createToolRegistry(
    createTestAgentConfig(root),
    projectIndex,
  );

  const schemas = registry.getToolSchemas();
  const findRefs = schemas.find((s) => s.name === "find_references");

  assert.ok(findRefs);
});

test("find_references returns disambiguation list for ambiguous bare symbol names", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-find-references-collisions-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export function serializeReview(review: Review) {
  return review.id;
}

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
  const tool = createFindReferencesTool(projectIndex);

  const result = await tool.execute({ name: "Review" });

  assert.ok(result.includes('Symbol "Review" is ambiguous'));
  assert.ok(result.includes("Review (type)"));
  assert.ok(result.includes("Review (class)"));
  assert.ok(result.includes("qualified: Review#type"));
  assert.ok(result.includes("qualified: Review#class"));
});

test("find_references accepts qualified names for colliding symbols", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-find-references-qualified-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export function serializeReview(review: Review) {
  return review.id;
}

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
  const tool = createFindReferencesTool(projectIndex);

  const result = await tool.execute({ name: "Review#class" });

  assert.ok(result.includes("# References to Review (class)"));
  assert.ok(result.includes("createReview"));
});
