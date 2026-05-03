import assert from "node:assert/strict";
import { test } from "node:test";

import { OpenAICompatibleModelClient } from "../src/model/client.js";
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

test("openai-compat client appends synthetic respond-tool when outputSchema is set", async () => {
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (_input, init) => {
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
                    name: "Invoice",
                    arguments: '{"vendor":"Acme","total":1234}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "test",
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

  // The synthetic tool was appended to the request alongside read_file.
  const parsedBody = JSON.parse(capturedBody) as Record<string, unknown>;
  const tools = parsedBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 2);
  const fns = tools.map((t) => (t.function as Record<string, unknown>).name);
  assert.deepEqual(fns, ["read_file", "Invoice"]);

  // The synthetic call was extracted into `output` and stripped from
  // `toolCalls` so the agent loop won't try to dispatch it.
  assert.deepEqual(response.output, { vendor: "Acme", total: 1234 });
  assert.equal(response.toolCalls.length, 0);
});

test("openai-compat client throws OutputValidationError on schema mismatch", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
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
                    name: "Invoice",
                    // total should be a number — provide string instead
                    arguments: '{"vendor":"Acme","total":"oops"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  await assert.rejects(
    () =>
      client.chat({
        model: "test",
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

test("openai-compat client passes through unchanged when outputSchema is omitted", async () => {
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
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const response = await client.chat({
    model: "test",
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

  const parsedBody = JSON.parse(capturedBody) as Record<string, unknown>;
  const tools = parsedBody.tools as Array<Record<string, unknown>>;
  assert.equal(tools.length, 1);
  assert.equal(response.output, undefined);
  assert.equal(response.text, "ok");
});

test("openai-compat client throws on outputSchema name collision with a real tool", async () => {
  const fetchImpl: typeof fetch = async () => new Response("{}");
  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });
  await assert.rejects(
    () =>
      client.chat({
        model: "test",
        system: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            name: "Invoice",
            description: "real tool with the same name",
            input_schema: { type: "object" },
          },
        ],
        maxTokens: 64,
        outputSchema: InvoiceSchema,
      }),
    /collides with a registered tool/,
  );
});
