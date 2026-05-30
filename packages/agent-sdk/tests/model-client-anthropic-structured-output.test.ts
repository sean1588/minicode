import assert from "node:assert/strict";
import { test } from "node:test";

import { AnthropicModelClient } from "../src/model/client.js";
import type { OutputSchema } from "../src/agent/types.js";
import { OutputValidationError } from "../src/agent/types.js";

const InvoiceSchema: OutputSchema = {
  name: "Invoice",
  description: "Extracted invoice fields",
  schema: {
    type: "object",
    properties: {
      vendor: { type: "string" },
      total: { type: "number" },
    },
    required: ["vendor", "total"],
    additionalProperties: false,
  },
};

interface FakeStreamOpts {
  finalMessage: unknown;
  onTextChunks?: string[];
}

/**
 * Minimal stand-in for the `MessageStream` returned by
 * `Anthropic.Messages.stream`. Only implements the surface the
 * client uses: `.on("text", fn)`, `.emitted("connect")`,
 * `.finalMessage()`, `.abort()`.
 */
function makeFakeStream(opts: FakeStreamOpts) {
  return {
    on(event: string, fn: (...args: unknown[]) => void) {
      if (event === "text" && opts.onTextChunks) {
        for (const chunk of opts.onTextChunks) {
          fn(chunk);
        }
      }
      return this;
    },
    emitted(): Promise<void> {
      return Promise.resolve();
    },
    finalMessage(): Promise<unknown> {
      return Promise.resolve(opts.finalMessage);
    },
    abort(): void {
      // no-op
    },
  };
}

interface CapturedRequest {
  params: Record<string, unknown>;
}

function makeFakeClient(opts: FakeStreamOpts): {
  fakeClient: object;
  captured: CapturedRequest;
} {
  const captured: CapturedRequest = { params: {} };
  const fakeClient = {
    messages: {
      stream(params: Record<string, unknown>) {
        captured.params = params;
        return makeFakeStream(opts);
      },
    },
  };
  return { fakeClient, captured };
}

test("anthropic client appends synthetic respond-tool when outputSchema is set", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Invoice",
          input: { vendor: "Acme", total: 1234 },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    // The fake "client" only implements `messages.stream`, which is all
    // chat() touches.
    client: fake.fakeClient as never,
  });

  const response = await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "read",
        input_schema: { type: "object", properties: {} },
      },
    ],
    maxTokens: 64,
    outputSchema: InvoiceSchema,
  });

  // The synthetic Invoice tool was appended after the real read_file
  // tool when the request was built.
  const tools = fake.captured.params.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.name, "read_file");
  assert.equal(tools[1]?.name, "Invoice");
  assert.deepEqual(tools[1]?.input_schema, InvoiceSchema.schema);

  // The synthetic tool_use block was extracted into output and stripped
  // from toolCalls so the agent loop won't try to dispatch it.
  assert.deepEqual(response.output, { vendor: "Acme", total: 1234 });
  assert.equal(response.toolCalls.length, 0);
});

test("anthropic client throws OutputValidationError on schema mismatch", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "Invoice",
          // total should be number; provide string instead
          input: { vendor: "Acme", total: "oops" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  await assert.rejects(
    () =>
      client.chat({
        model: "claude-test",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        maxTokens: 64,
        outputSchema: InvoiceSchema,
      }),
    (error: unknown) => {
      assert.ok(error instanceof OutputValidationError);
      assert.match(error.message, /Invoice.*failed schema validation/);
      return true;
    },
  );
});

test("anthropic client passes through unchanged when outputSchema is omitted", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  const response = await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "r",
        input_schema: { type: "object", properties: {} },
      },
    ],
    maxTokens: 64,
  });

  const tools = fake.captured.params.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, "read_file");
  assert.equal(response.output, undefined);
  assert.equal(response.text, "hello");
});

test("anthropic client groups parallel tool results into one user message", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tu_1", name: "read_file", input: { path: "a.ts" } },
          { id: "tu_2", name: "search", input: { pattern: "foo" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "tu_1",
        toolName: "read_file",
        content: "file contents",
      },
      {
        role: "tool",
        toolCallId: "tu_2",
        toolName: "search",
        content: "search results",
      },
    ],
    tools: [
      { name: "read_file", description: "r", input_schema: { type: "object", properties: {} } },
      { name: "search", description: "s", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
  });

  const messages = fake.captured.params.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 3);
  assert.equal(messages[1]?.role, "assistant");
  const assistantContent = messages[1]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    assistantContent.map((block) => block.type),
    ["tool_use", "tool_use"],
  );

  assert.equal(messages[2]?.role, "user");
  const toolResults = messages[2]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    toolResults.map((block) => block.type),
    ["tool_result", "tool_result"],
  );
  assert.deepEqual(
    toolResults.map((block) => block.tool_use_id),
    ["tu_1", "tu_2"],
  );
  assert.deepEqual(
    toolResults.map((block) => block.content),
    ["file contents", "search results"],
  );
});

test("anthropic client keeps out-of-order tool results without placeholders", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tu_1", name: "read_file", input: { path: "a.ts" } },
          { id: "tu_2", name: "search", input: { pattern: "foo" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "tu_2",
        toolName: "search",
        content: "search results",
      },
      {
        role: "tool",
        toolCallId: "tu_1",
        toolName: "read_file",
        content: "file contents",
      },
    ],
    tools: [
      { name: "read_file", description: "r", input_schema: { type: "object", properties: {} } },
      { name: "search", description: "s", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
  });

  const messages = fake.captured.params.messages as Array<Record<string, unknown>>;
  const toolResults = messages[2]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    toolResults.map((block) => block.tool_use_id),
    ["tu_2", "tu_1"],
  );
  assert.deepEqual(
    toolResults.map((block) => block.content),
    ["search results", "file contents"],
  );
  assert.ok(
    toolResults.every(
      (block) => !String(block.content).includes("Tool result unavailable"),
    ),
  );
});

test("anthropic client drops orphan tool results", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tu_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        toolCallId: "tu_99",
        toolName: "search",
        content: "orphan result",
      },
      {
        role: "tool",
        toolCallId: "tu_1",
        toolName: "read_file",
        content: "file contents",
      },
    ],
    tools: [
      { name: "read_file", description: "r", input_schema: { type: "object", properties: {} } },
      { name: "search", description: "s", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
  });

  const messages = fake.captured.params.messages as Array<Record<string, unknown>>;
  const toolResults = messages[2]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    toolResults.map((block) => block.tool_use_id),
    ["tu_1"],
  );
  assert.deepEqual(
    toolResults.map((block) => block.content),
    ["file contents"],
  );
});

test("anthropic client inserts placeholder results for interrupted tool calls", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tu_1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
      { role: "user", content: "new request" },
    ],
    tools: [
      { name: "read_file", description: "r", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
  });

  const messages = fake.captured.params.messages as Array<Record<string, unknown>>;
  assert.equal(messages.length, 4);
  const placeholderMessage = messages[2];
  assert.equal(placeholderMessage?.role, "user");
  const content = placeholderMessage?.content as Array<Record<string, unknown>>;
  assert.equal(content[0]?.type, "tool_result");
  assert.equal(content[0]?.tool_use_id, "tu_1");
  assert.match(String(content[0]?.content), /Tool result unavailable/);
  assert.deepEqual(messages[3], { role: "user", content: "new request" });
});

test("anthropic client extracts synthetic call alongside real tool calls", async () => {
  // Multi-tool step: model calls a real tool AND the synthetic tool.
  // The synthetic call should be extracted; the real call should
  // remain in `toolCalls`.
  const fake = makeFakeClient({
    finalMessage: {
      content: [
        { type: "text", text: "ok" },
        {
          type: "tool_use",
          id: "tu_1",
          name: "read_file",
          input: { path: "x.txt" },
        },
        {
          type: "tool_use",
          id: "tu_2",
          name: "Invoice",
          input: { vendor: "Acme", total: 50 },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });

  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });

  const response = await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "r",
        input_schema: { type: "object", properties: {} },
      },
    ],
    maxTokens: 64,
    outputSchema: InvoiceSchema,
  });

  assert.deepEqual(response.output, { vendor: "Acme", total: 50 });
  assert.equal(response.toolCalls.length, 1);
  assert.equal(response.toolCalls[0]?.name, "read_file");
});

// ---------------------------------------------------------------------------
// tool_choice forwarding
// ---------------------------------------------------------------------------

test("anthropic client omits tool_choice by default", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "read_file", description: "read", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
  });
  assert.equal(fake.captured.params.tool_choice, undefined);
});

test("anthropic client forwards toolChoice='required' as { type: 'any' }", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "read_file",
          input: { path: "foo.ts" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "read_file", description: "read", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 64,
    toolChoice: "required",
  });
  assert.deepEqual(fake.captured.params.tool_choice, { type: "any" });
});

test("anthropic client downgrades toolChoice='required' to { type: 'auto' } when tools is empty", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 64,
    toolChoice: "required",
  });
  assert.deepEqual(fake.captured.params.tool_choice, { type: "auto" });
});

test("anthropic client clamps low thinking budgets to the provider minimum", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: "read_file", description: "read", input_schema: { type: "object", properties: {} } },
    ],
    maxTokens: 4096,
    reasoningEffort: "minimal",
    toolChoice: "required",
  });
  assert.deepEqual(fake.captured.params.thinking, {
    type: "enabled",
    budget_tokens: 1024,
  });
  assert.deepEqual(fake.captured.params.tool_choice, { type: "auto" });
});

test("anthropic client omits thinking when max token cap is below provider minimum", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 512,
    reasoningEffort: "high",
  });
  assert.equal(fake.captured.params.thinking, undefined);
});

test("anthropic client omits thinking when explicit reasoning cap is below provider minimum", async () => {
  const fake = makeFakeClient({
    finalMessage: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  const client = new AnthropicModelClient("test-key", {
    client: fake.fakeClient as never,
  });
  await client.chat({
    model: "claude-test",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    maxTokens: 8192,
    reasoningEffort: "high",
    reasoningMaxTokens: 512,
  });
  assert.equal(fake.captured.params.thinking, undefined);
});
