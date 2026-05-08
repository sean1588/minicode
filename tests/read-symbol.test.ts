import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createReadSymbolTool } from "../src/tools/read-symbol.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig } from "./test-utils.js";

test("read_symbol returns correct function body", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "loadAgentConfig" });

  assert.ok(result.includes("# loadAgentConfig"));
  assert.ok(result.includes("src/agent/config.ts"));
  assert.ok(result.includes("Lines:"));
  assert.ok(/\d+\|/.test(result), "should have line numbers");
  assert.ok(result.includes("loadAgentConfig") || result.includes("config"));
});

test("read_symbol returns error for unknown symbol name", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "NonExistentSymbol123" });

  assert.ok(result.includes("not found"));
  assert.ok(result.includes("search") || result.includes("read_file"));
  // Miss path should preferentially nudge toward search_code_map (the
  // graph-aware retry) before suggesting full-file reads — otherwise
  // the agent abandons minicode's symbol-aware path the moment it
  // hits a single miss.
  assert.ok(
    result.includes("search_code_map"),
    `expected miss message to suggest search_code_map; got: ${result}`,
  );
});

test("read_symbol with includeBody: false returns signature only", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({
    name: "formatConfigForDisplay",
    includeBody: false,
  });

  assert.ok(result.includes("# formatConfigForDisplay"));
  assert.ok(result.includes("src/agent/config.ts"));
  assert.ok(!result.includes("return lines.join"));
  assert.ok(result.includes("config") || result.includes("=>"));
});

test("read_symbol includes leading context and line numbers", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const symbol = projectIndex.getSymbol("loadAgentConfig");
  assert.ok(symbol, "loadAgentConfig should exist");

  const result = await tool.execute({ name: "loadAgentConfig" });

  assert.ok(result.includes("# loadAgentConfig"));
  assert.ok(result.includes("src/agent/config.ts"));
  assert.ok(/\d+\|/.test(result), "should have line numbers in output");
});

test("read_symbol appears in tool registry schemas when projectIndex provided", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const registry = createToolRegistry(config, projectIndex);

  const schemas = registry.getToolSchemas();
  const readSymbol = schemas.find((s) => s.name === "read_symbol");

  assert.ok(readSymbol, "read_symbol should be in schemas");
  assert.ok(readSymbol!.description.includes("function") || readSymbol!.description.includes("class"));
  const props = readSymbol!.input_schema.properties as Record<string, unknown> | undefined;
  assert.ok(props && "name" in props);
});

test("MINICODE_TOOL_PROFILE=file-search-only omits the five graph-aware tools", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);

  const original = process.env.MINICODE_TOOL_PROFILE;
  process.env.MINICODE_TOOL_PROFILE = "file-search-only";
  try {
    const registry = createToolRegistry(config, projectIndex);
    const schemas = registry.getToolSchemas();
    const names = new Set(schemas.map((s) => s.name));

    // Graph-aware tools must be absent in file-search-only mode.
    for (const omitted of [
      "read_symbol",
      "find_references",
      "get_dependencies",
      "find_path",
      "search_code_map",
    ]) {
      assert.ok(!names.has(omitted), `expected ${omitted} to be absent`);
    }

    // Core file/search/run tools must still be present — that's the
    // "search-only" half of the profile name.
    for (const required of [
      "read_file",
      "write_file",
      "edit_file",
      "search",
      "list_files",
      "run_command",
    ]) {
      assert.ok(names.has(required), `expected ${required} to be present`);
    }
  } finally {
    if (original === undefined) {
      delete process.env.MINICODE_TOOL_PROFILE;
    } else {
      process.env.MINICODE_TOOL_PROFILE = original;
    }
  }
});

test("createToolRegistry includes graph-aware tools by default when projectIndex is provided", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);

  // Must run with no MINICODE_TOOL_PROFILE set, otherwise the env from a
  // host shell would mask the default behavior.
  const original = process.env.MINICODE_TOOL_PROFILE;
  delete process.env.MINICODE_TOOL_PROFILE;
  try {
    const registry = createToolRegistry(config, projectIndex);
    const names = new Set(registry.getToolSchemas().map((s) => s.name));
    for (const required of [
      "read_symbol",
      "find_references",
      "get_dependencies",
      "find_path",
      "search_code_map",
    ]) {
      assert.ok(names.has(required), `expected ${required} to be present by default`);
    }
  } finally {
    if (original !== undefined) {
      process.env.MINICODE_TOOL_PROFILE = original;
    }
  }
});

test("read_symbol includes Referenced Types section for createToolRegistry", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "createToolRegistry" });

  assert.ok(result.includes("# createToolRegistry"));
  assert.ok(result.includes("src/tools/registry.ts"));
});

test("read_symbol returns disambiguation list for ambiguous bare symbol names", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-read-symbol-collisions-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export class Review {
  constructor(public id: string) {}
}
`,
    "utf8",
  );

  const config = createTestAgentConfig(workspaceRoot);
  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "Review" });

  assert.ok(result.includes('Symbol "Review" is ambiguous'));
  assert.ok(result.includes("Review (type)"));
  assert.ok(result.includes("Review (class)"));
  assert.ok(result.includes("qualified: Review#type"));
  assert.ok(result.includes("qualified: Review#class"));
});

test("read_symbol accepts qualified names for colliding symbols", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-read-symbol-qualified-"));
  await writeFile(
    path.join(workspaceRoot, "sample.ts"),
    `export type Review = { id: string };

export class Review {
  constructor(public id: string) {}
}
`,
    "utf8",
  );

  const config = createTestAgentConfig(workspaceRoot);
  const projectIndex = await buildProjectIndex(workspaceRoot);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "Review#class", includeBody: false });

  assert.ok(result.includes("# Review (class) (class)"));
  assert.ok(result.includes("sample.ts"));
});

test("read_symbol is not in tool registry when projectIndex is undefined", () => {
  const config = createTestAgentConfig("/tmp");
  const registry = createToolRegistry(config);

  const schemas = registry.getToolSchemas();
  const readSymbol = schemas.find((s) => s.name === "read_symbol");

  assert.equal(readSymbol, undefined);
});
