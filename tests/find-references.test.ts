import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

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
