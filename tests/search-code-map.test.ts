import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import {
  buildAmbiguityHint,
  createSearchCodeMapTool,
  summarizeDocComment,
} from "../src/tools/search-code-map.js";
import type { IndexedSymbol } from "../src/indexer/types.js";

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

// ─── Direct helper unit tests ──────────────────────────────────────────

test("summarizeDocComment returns empty string for missing input", () => {
  assert.equal(summarizeDocComment(undefined), "");
  assert.equal(summarizeDocComment(""), "");
  assert.equal(summarizeDocComment("   \n  \n"), "");
});

test("summarizeDocComment strips JSDoc markers and returns first non-empty line", () => {
  const input = "/**\n * First sentence here.\n * More detail.\n */";
  assert.equal(summarizeDocComment(input), "First sentence here.");
});

test("summarizeDocComment splits on \\r-only line separators (TS compiler shape)", () => {
  // The TS compiler stores docComment with `\r` line separators on some
  // platforms — without explicit `\r` handling the whole comment becomes
  // a single line and the truncation chops mid-paragraph rather than at
  // the first description sentence.
  const input = "First sentence.\rSecond sentence.\rThird sentence.";
  assert.equal(summarizeDocComment(input), "First sentence.");
});

test("summarizeDocComment truncates long first lines with ellipsis", () => {
  const longLine = "a".repeat(150);
  const result = summarizeDocComment(longLine);
  assert.equal(result.length, 100);
  assert.ok(result.endsWith("..."));
});

function makeSymbol(kind: IndexedSymbol["kind"], name = "X"): IndexedSymbol {
  return {
    name,
    qualifiedName: name,
    kind,
    filePath: "x.ts",
    startLine: 1,
    endLine: 1,
    exported: true,
  } as IndexedSymbol;
}

test("buildAmbiguityHint stays quiet when all matches share one kind", () => {
  const matches = [makeSymbol("function"), makeSymbol("function")];
  assert.equal(buildAmbiguityHint(matches), "");
});

test("buildAmbiguityHint stays quiet for class-with-its-methods", () => {
  const matches = [makeSymbol("class"), makeSymbol("method"), makeSymbol("method")];
  assert.equal(buildAmbiguityHint(matches), "");
});

test("buildAmbiguityHint fires for class + standalone function (noun-vs-verb)", () => {
  const matches = [makeSymbol("class"), makeSymbol("function")];
  const hint = buildAmbiguityHint(matches);
  assert.match(hint, /results span multiple symbol kinds/);
  assert.match(hint, /read_symbol/);
});

test("buildAmbiguityHint fires for interface + standalone function", () => {
  const matches = [makeSymbol("interface"), makeSymbol("function")];
  assert.match(buildAmbiguityHint(matches), /results span multiple symbol kinds/);
});

test("buildAmbiguityHint stays quiet when only methods accompany the noun (no standalone function)", () => {
  // Documents the deliberate trade-off: cross-class method collisions
  // are under-flagged to avoid noisy false positives on the more
  // common class-with-its-own-methods shape.
  const matches = [makeSymbol("class"), makeSymbol("method")];
  assert.equal(buildAmbiguityHint(matches), "");
});
