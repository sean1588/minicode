import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
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
  const { createToolRegistry } = await import("../src/tools/registry.js");
  const { createTestAgentConfig } = await import("./test-utils.js");
  const registry = createToolRegistry(
    createTestAgentConfig(root),
    projectIndex,
  );

  const schemas = registry.getToolSchemas();
  const searchCodeMap = schemas.find((s) => s.name === "search_code_map");

  assert.ok(searchCodeMap);
});

test("search_code_map shows colliding symbols with disambiguated display names", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-search-collisions-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export interface Employee {
  id: string;
}

export class Employee {
  constructor(public id: string) {}
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "Employee" });

  assert.ok(result.includes("Employee (interface)"));
  assert.ok(result.includes("Employee (class)"));
});
