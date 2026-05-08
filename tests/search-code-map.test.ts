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

test("search_code_map returns similar matches when exact substring lookup fails", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "ModelRespnse" });

  assert.ok(result.includes('No exact substring matches for "ModelRespnse"'));
  assert.ok(result.includes("Showing similar symbols instead"));
  assert.ok(result.includes("ModelResponse"));
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
  assert.ok(result.includes("qualified: Employee#interface"));
  assert.ok(result.includes("qualified: Employee#class"));
});

// ─── Issue #184: disambiguation hints + doc summaries ──────────────────

test("search_code_map surfaces JSDoc summaries beside each match (issue #184)", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-doc-summaries-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `/**
 * Create a default ToolWidget with all builtin gears.
 * Wraps the SDK class for application-level setup.
 */
export function createToolWidget(): ToolWidget {
  return new ToolWidget();
}

export class ToolWidget {
  constructor() {}
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "ToolWidget" });

  // The doc summary's first line should appear under the createToolWidget
  // entry — without it, the model can't tell `ToolWidget` (the class) apart
  // from `createToolWidget` (the factory) by kind+path alone.
  assert.match(result, /Create a default ToolWidget with all builtin gears\./);

  // Each shown match should still expose its qualified name, intact.
  assert.match(result, /qualified: ToolWidget/);
  assert.match(result, /qualified: createToolWidget/);
});

test("search_code_map prepends an ambiguity hint when matches span class + function (issue #184)", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-ambiguity-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export class Widget {
  constructor() {}
}

export function createWidget(): Widget {
  return new Widget();
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "Widget" });

  // The hint specifically calls out the noun-vs-verb-form shape that
  // led to the find-tool-registration regression.
  assert.match(result, /Note: results span multiple symbol kinds/);
  assert.match(result, /class\/interface\/type and a function\/method/);
  assert.match(result, /read_symbol/);
});

test("search_code_map does NOT prepend the ambiguity hint when matches are all the same kind", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-no-ambiguity-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export function widgetA(): void {}
export function widgetB(): void {}
export function widgetC(): void {}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "widget" });

  // All three are functions — no ambiguity to flag.
  assert.doesNotMatch(result, /results span multiple symbol kinds/);
});

test("search_code_map does NOT prepend the ambiguity hint for class-with-its-methods", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-class-methods-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export class Widget {
  init(): void {}
  destroy(): void {}
}
`,
    "utf8",
  );

  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createSearchCodeMapTool(projectIndex);

  const result = await tool.execute({ pattern: "Widget" });

  // class + methods is a structurally expected pairing, not a noun/verb
  // disambiguation problem. The hint should stay quiet here.
  assert.doesNotMatch(result, /results span multiple symbol kinds/);
});
