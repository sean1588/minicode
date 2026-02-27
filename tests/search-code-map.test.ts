import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createSearchCodeMapTool } from "../src/tools/search-code-map.js";

test("search_code_map finds symbols by substring", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "ModelResponse" });

  assert.ok(result.includes("# Symbols matching"));
  assert.ok(result.includes("ModelResponse"));
});

test("search_code_map returns empty when no match", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "XyZNoSymbol123" });

  assert.ok(result.includes("No symbols matching"));
});

test("search_code_map appears in tool registry when projectIndex provided", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const { createTestAgentConfig } = await import("./test-utils.js");
  const registry = ToolRegistry.createDefault(
    createTestAgentConfig(root),
    projectIndex,
  );

  const schemas = registry.getToolSchemas();
  const searchCodeMap = schemas.find((s) => s.name === "search_code_map");

  assert.ok(searchCodeMap);
});
