import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildSystemPrompt } from "../src/prompt/system-prompt.js";
import type { AgentConfig, ToolSchema } from "../src/agent/types.js";

function createMinimalConfig(workspaceRoot: string): AgentConfig {
  return {
    modelProvider: "openai-compatible",
    model: "test",
    maxSteps: 10,
    maxTokens: 1024,
    maxContextTokens: 16_000,
    workspaceRoot,
    commandTimeoutMs: 5000,
    maxFileSizeBytes: 1_000_000,
    commandDenylist: [],
    confirmDestructive: false,
    keepRecentMessages: 10,
    loopDetectionWindow: 6,
    maxToolOutputChars: 15_000,
    openAiBaseUrl: "http://localhost:1234/v1",
  };
}

const MINIMAL_TOOLS: ToolSchema[] = [
  {
    name: "read_file",
    description: "Read a file",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
];

test("buildSystemPrompt omits code map when undefined", () => {
  const prompt = buildSystemPrompt(
    createMinimalConfig("/tmp"),
    MINIMAL_TOOLS,
  );
  assert.ok(!prompt.includes("[Project Code Map]"));
  assert.ok(prompt.includes("[Identity]"));
  assert.ok(prompt.includes("[Tool Descriptions]"));
});

test("buildSystemPrompt omits code map when empty string", () => {
  const prompt = buildSystemPrompt(
    createMinimalConfig("/tmp"),
    MINIMAL_TOOLS,
    "",
  );
  assert.ok(!prompt.includes("[Project Code Map]"));
});

test("buildSystemPrompt includes code map when provided", () => {
  const codeMap = "# Project Code Map\n\n  src/foo.ts\n    function bar()";
  const prompt = buildSystemPrompt(
    createMinimalConfig("/tmp"),
    MINIMAL_TOOLS,
    codeMap,
  );
  assert.ok(prompt.includes("[Project Code Map]"));
  assert.ok(prompt.includes("src/foo.ts"));
  assert.ok(prompt.includes("function bar()"));
});

test("buildSystemPrompt includes workspace context", () => {
  const prompt = buildSystemPrompt(
    createMinimalConfig("/home/user/project"),
    MINIMAL_TOOLS,
  );
  assert.ok(prompt.includes("/home/user/project"));
});

test("buildSystemPrompt includes tool list", () => {
  const prompt = buildSystemPrompt(
    createMinimalConfig("/tmp"),
    MINIMAL_TOOLS,
  );
  assert.ok(prompt.includes("read_file"));
  assert.ok(prompt.includes("Read a file"));
});

test("buildSystemPrompt detects project type from workspace", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const prompt = buildSystemPrompt(
    createMinimalConfig(root),
    MINIMAL_TOOLS,
  );
  assert.ok(
    prompt.includes("Node.js") || prompt.includes("TypeScript"),
    "mini-coder has package.json",
  );
});
