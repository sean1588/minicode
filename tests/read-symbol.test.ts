import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createReadSymbolTool } from "../src/tools/read-symbol.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig } from "./test-utils.js";

test("read_symbol returns correct function body", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "CodingAgent.runTurn" });

  assert.ok(result.includes("# CodingAgent.runTurn"));
  assert.ok(result.includes("src/agent/agent.ts"));
  assert.ok(result.includes("Lines:"));
  assert.ok(/\d+\|/.test(result), "should have line numbers");
  assert.ok(result.includes("runTurn") || result.includes("session"));
});

test("read_symbol returns error for unknown symbol name", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "NonExistentSymbol123" });

  assert.ok(result.includes("not found"));
  assert.ok(result.includes("search") || result.includes("read_file"));
});

test("read_symbol with includeBody: false returns signature only", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({
    name: "parseResponse",
    includeBody: false,
  });

  assert.ok(result.includes("# parseResponse"));
  assert.ok(result.includes("src/model/client.ts"));
  assert.ok(!result.includes("return {"));
  assert.ok(result.includes("ModelResponse") || result.includes("=>"));
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
  const registry = ToolRegistry.createDefault(config, projectIndex);

  const schemas = registry.getToolSchemas();
  const readSymbol = schemas.find((s) => s.name === "read_symbol");

  assert.ok(readSymbol, "read_symbol should be in schemas");
  assert.ok(readSymbol!.description.includes("function") || readSymbol!.description.includes("class"));
  const props = readSymbol!.input_schema.properties as Record<string, unknown> | undefined;
  assert.ok(props && "name" in props);
});

test("read_symbol includes Referenced Types section for parseResponse", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const config = createTestAgentConfig(root);
  const projectIndex = await buildProjectIndex(root);
  const tool = createReadSymbolTool(config, projectIndex);

  const result = await tool.execute({ name: "parseResponse" });

  assert.ok(result.includes("## Referenced Types"));
  assert.ok(result.includes("ModelResponse"));
  assert.ok(result.includes("ToolCall"));
});

test("read_symbol is not in tool registry when projectIndex is undefined", () => {
  const config = createTestAgentConfig("/tmp");
  const registry = ToolRegistry.createDefault(config);

  const schemas = registry.getToolSchemas();
  const readSymbol = schemas.find((s) => s.name === "read_symbol");

  assert.equal(readSymbol, undefined);
});
