import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolDefinition } from "../src/agent/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig as createTestConfig } from "./test-utils.js";

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Echo input value",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "string" },
    },
    required: ["value"],
  },
  execute: async (input) => `echo:${String(input.value)}`,
};

test("tool registry rejects duplicate tool names", () => {
  assert.throws(
    () => new ToolRegistry([echoTool, echoTool]),
    /Duplicate tool registration/,
  );
});

test("tool registry returns error for unknown tool", async () => {
  const registry = new ToolRegistry([echoTool]);
  const result = await registry.execute("missing", {});
  assert.equal(result, 'Tool error: Unknown tool "missing".');
});

test("tool registry validates input shape", async () => {
  const registry = new ToolRegistry([echoTool]);
  const result = await registry.execute("echo", "bad-input");
  assert.match(result, /Tool input must be a JSON object/);
});

test("tool registry returns wrapped tool execution errors", async () => {
  const explodingTool: ToolDefinition = {
    name: "explode",
    description: "Always fails",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      throw new Error("boom");
    },
  };
  const registry = new ToolRegistry([explodingTool]);
  const result = await registry.execute("explode", {});
  assert.equal(result, "Tool error (explode): boom");
});

test("tool registry getToolSchemas returns schemas for all tools", () => {
  const registry = new ToolRegistry([echoTool]);
  const schemas = registry.getToolSchemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0]?.name, "echo");
  assert.equal(schemas[0]?.description, "Echo input value");
  assert.ok(schemas[0]?.input_schema);
});

test("tool registry executes tools successfully", async () => {
  const registry = new ToolRegistry([echoTool]);
  const result = await registry.execute("echo", { value: "hello" });
  assert.equal(result, "echo:hello");
});

test("tool registry createDefault creates all core tools", () => {
  const config = createTestConfig("/tmp");
  const registry = ToolRegistry.createDefault(config);
  const schemas = registry.getToolSchemas();
  const names = schemas.map((s) => s.name);
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("write_file"));
  assert.ok(names.includes("edit_file"));
  assert.ok(names.includes("search"));
  assert.ok(names.includes("list_files"));
  assert.ok(names.includes("run_command"));
  assert.equal(schemas.length, 6);
});
