import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "../src/prompt/system-prompt.js";
import { createTestAgentConfig } from "./test-utils.js";

test("system prompt includes identity and workspace context", () => {
  const config = createTestAgentConfig("/tmp/myproject");
  const prompt = buildSystemPrompt(config, []);

  assert.ok(prompt.includes("[Identity]"));
  assert.ok(prompt.includes("coding agent"));
  assert.ok(prompt.includes("[Workspace Context]"));
  assert.ok(prompt.includes("/tmp/myproject"));
});

test("system prompt includes tool descriptions", () => {
  const config = createTestAgentConfig("/tmp");
  const tools = [
    {
      name: "read_file",
      description: "Read a file",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const prompt = buildSystemPrompt(config, tools);
  assert.ok(prompt.includes("read_file: Read a file"));
});

test("system prompt includes code map when provided", () => {
  const config = createTestAgentConfig("/tmp");
  const codeMap = {
    text: "# Code Map\n- FooClass\n- BarFunction",
    shownCount: 2,
    totalCount: 2,
  };

  const prompt = buildSystemPrompt(config, [], codeMap);
  assert.ok(prompt.includes("[Project Code Map]"));
  assert.ok(prompt.includes("FooClass"));
  assert.ok(prompt.includes("BarFunction"));
});

test("system prompt shows truncation hint when code map is partial", () => {
  const config = createTestAgentConfig("/tmp");
  const codeMap = {
    text: "# Code Map\n- FooClass",
    shownCount: 1,
    totalCount: 100,
  };

  const prompt = buildSystemPrompt(config, [], codeMap);
  assert.ok(prompt.includes("Showing 1 of 100 symbols"));
});

test("system prompt omits code map when not provided", () => {
  const config = createTestAgentConfig("/tmp");
  const prompt = buildSystemPrompt(config, []);
  assert.ok(!prompt.includes("[Project Code Map]"));
});

test("system prompt includes safety rules", () => {
  const config = createTestAgentConfig("/tmp");
  const prompt = buildSystemPrompt(config, []);
  assert.ok(prompt.includes("[Safety Rules]"));
  assert.ok(prompt.includes("Never modify files outside the workspace"));
});

test("system prompt includes specialized tool guidance when present", () => {
  const config = createTestAgentConfig("/tmp");
  const tools = [
    {
      name: "read_symbol",
      description: "Read a symbol",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "find_references",
      description: "Find references",
      input_schema: { type: "object", properties: {} },
    },
  ];

  const prompt = buildSystemPrompt(config, tools);
  assert.ok(prompt.includes("PREFER read_symbol"));
  assert.ok(prompt.includes("find_references"));
});
