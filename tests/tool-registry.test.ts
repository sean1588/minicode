import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolDefinition } from "../src/agent/types.js";
import { ToolRegistry } from "../src/tools/registry.js";

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
