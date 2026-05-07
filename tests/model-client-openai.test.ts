import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenAICompatibleModelClient,
  createModelClient,
} from "@sean.holung/minicode-sdk";
import type { AgentConfig } from "@sean.holung/minicode-sdk";
import { createTestAgentConfig } from "./test-utils.js";

test("openai-compatible client sends tool schemas and parses tool calls", async () => {
  let capturedUrl = "";
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: "{\"path\":\"src/index.ts\"}",
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "qwen2.5-coder-7b-instruct",
    system: "System instructions",
    messages: [{ role: "user", content: "Read src/index.ts" }],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
          required: ["path"],
        },
      },
    ],
    maxTokens: 256,
  });

  assert.equal(capturedUrl, "http://localhost:1234/v1/chat/completions");
  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "read_file");
  assert.deepEqual(response.toolCalls[0]?.input, { path: "src/index.ts" });
  assert.equal(response.usage.inputTokens, 10);
  assert.equal(response.usage.outputTokens, 5);

  const parsedBody = JSON.parse(capturedBody) as Record<string, unknown>;
  const messages = parsedBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[1]?.role, "user");

  const tools = parsedBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools[0]?.type, "function");
});

test("openai-compatible client sends correct app URL in HTTP-Referer header", async () => {
  let capturedHeaders: Record<string, string> = {};

  const fetchImpl: typeof fetch = async (_input, init) => {
    const rawHeaders = init?.headers as Record<string, string> | undefined;
    capturedHeaders = rawHeaders ?? {};
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "hello", tool_calls: [] },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  await client.chat({
    model: "test-model",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 64,
  });

  assert.equal(
    capturedHeaders["HTTP-Referer"],
    "https://minicode.seanholung.com",
    "HTTP-Referer should point to minicode.seanholung.com",
  );
  assert.equal(capturedHeaders["X-Title"], "minicode");
});

test("openai-compatible client repairs missing tool results before sending", async () => {
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "ok", tool_calls: [] },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  await client.chat({
    model: "test-model",
    system: "sys",
    messages: [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "call-missing", name: "read_file", input: { path: "src/index.ts" } }],
      },
      { role: "user", content: "continue" },
    ],
    tools: [],
    maxTokens: 64,
  });

  const parsedBody = JSON.parse(capturedBody) as Record<string, unknown>;
  const messages = parsedBody.messages as Array<Record<string, unknown>>;
  assert.equal(messages[2]?.role, "assistant");
  assert.equal(messages[3]?.role, "tool");
  assert.equal(messages[3]?.tool_call_id, "call-missing");
  assert.match(String(messages[3]?.content), /Tool result unavailable/);
  assert.equal(messages[4]?.role, "user");
});

test("createModelClient returns openai-compatible client", () => {
  const config: AgentConfig = {
    ...createTestAgentConfig("/tmp"),
    modelProvider: "openai-compatible",
    openAiBaseUrl: "http://localhost:1234/v1",
  };

  const client = createModelClient(config);
  assert.ok(client instanceof OpenAICompatibleModelClient);
});
