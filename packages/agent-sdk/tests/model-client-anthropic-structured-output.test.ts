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
