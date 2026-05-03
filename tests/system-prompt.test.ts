import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildSystemPrompt } from "@minicode/agent-sdk";
import type { AgentConfig, ToolSchema } from "@minicode/agent-sdk";

function createMinimalConfig(workspaceRoot: string): AgentConfig {
  return {
    modelProvider: "openai-compatible",
    model: "test",
    maxSteps: 10,
    maxTokens: 1024,
    modelTimeoutSeconds: 60,
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

const TOOLS_WITH_SEARCH_CODE_MAP: ToolSchema[] = [
  ...MINIMAL_TOOLS,
  {
    name: "search_code_map",
    description: "Search the code map",
    input_schema: { type: "object", properties: { pattern: { type: "string" } } },
  },
];

test("buildSystemPrompt omits code map when undefined", () => {
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: MINIMAL_TOOLS,
  });
  assert.ok(!prompt.includes("[Project Code Map]"));
  assert.ok(prompt.includes("[Identity]"));
  assert.ok(prompt.includes("[Tool Descriptions]"));
});

test("buildSystemPrompt omits code map when empty", () => {
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: MINIMAL_TOOLS,
    codeMap: { text: "", shownCount: 0, totalCount: 0 },
  });
  assert.ok(!prompt.includes("[Project Code Map]"));
});

test("buildSystemPrompt includes code map when provided", () => {
  const codeMap = {
    text: "# Project Code Map\n\n  src/foo.ts\n    function bar()",
    shownCount: 1,
    totalCount: 1,
  };
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: MINIMAL_TOOLS,
    codeMap,
  });
  assert.ok(prompt.includes("[Project Code Map]"));
  assert.ok(prompt.includes("src/foo.ts"));
  assert.ok(prompt.includes("function bar()"));
});

test("buildSystemPrompt includes workspace context", () => {
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/home/user/project"),
    tools: MINIMAL_TOOLS,
  });
  assert.ok(prompt.includes("/home/user/project"));
});

test("buildSystemPrompt omits runtime budget knobs", () => {
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: MINIMAL_TOOLS,
  });

  assert.doesNotMatch(prompt, /maxSteps/i);
  assert.doesNotMatch(prompt, /maxTokens/i);
  assert.doesNotMatch(prompt, /modelTimeoutSeconds/i);
  assert.doesNotMatch(prompt, /maxContextTokens/i);
  assert.doesNotMatch(prompt, /commandTimeoutMs/i);
});

test("buildSystemPrompt includes tool list", () => {
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: MINIMAL_TOOLS,
  });
  assert.ok(prompt.includes("read_file"));
  assert.ok(prompt.includes("Read a file"));
});

test("buildSystemPrompt shows truncated stats and search_code_map hint when truncated", () => {
  const codeMap = {
    text: "# Project Code Map\n\n  src/foo.ts\n    function bar()",
    shownCount: 5,
    totalCount: 100,
  };
  const prompt = buildSystemPrompt({
    config: createMinimalConfig("/tmp"),
    tools: TOOLS_WITH_SEARCH_CODE_MAP,
    codeMap,
  });
  assert.ok(prompt.includes("Showing 5 of 100 symbols"));
  assert.ok(prompt.includes("search_code_map to find symbols not listed above"));
});

test("buildSystemPrompt detects project type from workspace", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const prompt = buildSystemPrompt({
    config: createMinimalConfig(root),
    tools: MINIMAL_TOOLS,
  });
  assert.ok(
    prompt.includes("Node.js") || prompt.includes("TypeScript"),
    "minicode has package.json",
  );
});
