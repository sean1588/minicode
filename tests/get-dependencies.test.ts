import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createGetDependenciesTool } from "../src/tools/get-dependencies.js";

test("get_dependencies returns dependency cone for createModelClient", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createGetDependenciesTool(projectIndex);

  const result = await tool.execute({ name: "createModelClient" });

  assert.ok(result.includes("# Dependencies of createModelClient"));
  assert.ok(result.includes("AgentConfig"));
});

test("get_dependencies respects depth parameter", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createGetDependenciesTool(projectIndex);

  const resultDepth1 = await tool.execute({
    name: "parseResponse",
    depth: 1,
  });
  const resultDepth2 = await tool.execute({
    name: "parseResponse",
    depth: 2,
  });

  assert.ok(resultDepth1.includes("parseResponse"));
  assert.ok(resultDepth2.includes("parseResponse"));
});

test("get_dependencies returns error for unknown symbol", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createGetDependenciesTool(projectIndex);

  const result = await tool.execute({ name: "NonExistent" });

  assert.ok(result.includes("not found"));
});
