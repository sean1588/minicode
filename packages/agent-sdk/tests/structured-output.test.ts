import assert from "node:assert/strict";
import { test } from "node:test";

import { CodingAgent } from "../src/agent/agent.js";
import {
  extractStructuredOutput,
  synthesizeRespondTool,
  validateOutput,
  validateOutputSchema,
} from "../src/agent/structured-output.js";
import type {
  ModelClient,
  ModelResponse,
  OutputSchema,
  SessionMessage,
  ToolDefinition,
  ToolSchema,
} from "../src/agent/types.js";
import { OutputValidationError } from "../src/agent/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig } from "./test-utils.js";

const InvoiceSchema: OutputSchema = {
  name: "Invoice",
  description: "Extracted invoice data",
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

// ─── Helper module ───────────────────────────────────────────────────────────

test("synthesizeRespondTool builds a ToolSchema with the supplied schema", () => {
  const tool = synthesizeRespondTool(InvoiceSchema);
  assert.equal(tool.name, "Invoice");
  assert.equal(tool.description, "Extracted invoice data");
  assert.deepEqual(tool.input_schema, InvoiceSchema.schema);
});

test("synthesizeRespondTool falls back to a default description", () => {
  const noDesc: OutputSchema = {
    name: "Foo",
    schema: { type: "object", properties: {}, additionalProperties: false },
  };
  const tool = synthesizeRespondTool(noDesc);
  assert.match(tool.description, /Call this/);
});

test("validateOutputSchema rejects bad names and collisions", () => {
  assert.throws(
    () => validateOutputSchema({ name: "bad name", schema: {} }, []),
    /must match/,
  );
  assert.throws(
    () => validateOutputSchema({ name: "ok", schema: null as unknown as Record<string, unknown> }, []),
    /JSON Schema object/,
  );
  const realTool: ToolSchema = {
    name: "Invoice",
    description: "x",
    input_schema: { type: "object" },
  };
  assert.throws(
    () => validateOutputSchema(InvoiceSchema, [realTool]),
    /collides with a registered tool/,
  );
});

test("validateOutput returns the value when it matches the schema", () => {
  const value = { vendor: "Acme", total: 1234 };
  const out = validateOutput(InvoiceSchema, value);
  assert.deepEqual(out, value);
});

test("validateOutput throws OutputValidationError with diagnostic info on mismatch", () => {
  try {
    validateOutput(InvoiceSchema, { vendor: 5 });
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof OutputValidationError);
    assert.match(error.message, /Invoice.*failed schema validation/);
    assert.ok(error.errors.length > 0);
    assert.deepEqual(error.raw, { vendor: 5 });
  }
});

test("extractStructuredOutput pulls the synthetic call out and leaves real tool calls", () => {
  const result = extractStructuredOutput(InvoiceSchema, [
    { id: "1", name: "read_file", input: { path: "x.txt" } },
    { id: "2", name: "Invoice", input: { vendor: "Acme", total: 100 } },
    { id: "3", name: "write_file", input: { path: "y.txt", content: "ok" } },
  ]);
  assert.ok(result, "extractStructuredOutput should find the call");
  assert.deepEqual(result.output, { vendor: "Acme", total: 100 });
  assert.equal(result.remainingToolCalls.length, 2);
  assert.deepEqual(
    result.remainingToolCalls.map((c) => c.name),
    ["read_file", "write_file"],
  );
});

test("extractStructuredOutput returns null when the model didn't call the synthetic tool", () => {
  const result = extractStructuredOutput(InvoiceSchema, [
    { id: "1", name: "read_file", input: { path: "x.txt" } },
  ]);
  assert.equal(result, null);
});

// ─── Agent integration ───────────────────────────────────────────────────────

class CapturingClient implements ModelClient {
  toolsLastSeen: ToolSchema[] = [];
  outputSchemaLastSeen: OutputSchema | undefined = undefined;
  private readonly responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.responses = [...responses];
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
    outputSchema?: OutputSchema;
  }): Promise<ModelResponse> {
    this.toolsLastSeen = params.tools;
    this.outputSchemaLastSeen = params.outputSchema;
    const next = this.responses.shift();
    if (!next) throw new Error("No queued response.");
    return next;
  }
}

function buildAgentWithRegistry(
  client: ModelClient,
  tools: ToolDefinition[] = [],
): CodingAgent {
  return new CodingAgent({
    config: createTestAgentConfig("/tmp/structured-test"),
    modelClient: client,
    toolRegistry: new ToolRegistry(tools),
  });
}

function makeEchoTool(): ToolDefinition {
  return {
    name: "echo_tool",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    execute: async (input) => `echo:${String(input.value)}`,
  };
}

test("runTurn forwards outputSchema to the model client", async () => {
  // The client is responsible for appending the synthetic tool — but
  // when this test uses a fake client, we just verify the schema was
  // forwarded so the real clients (covered by their own tests) can do
  // their job.
  const client = new CapturingClient([
    {
      text: "",
      toolCalls: [
        { id: "1", name: "Invoice", input: { vendor: "Acme", total: 99 } },
      ],
      stopReason: "tool_use",
      // The fake client emulates what a real client does: extract the
      // synthetic call and surface it as `output`.
      output: { vendor: "Acme", total: 99 },
      usage: { inputTokens: 5, outputTokens: 5 },
    },
  ]);
  const agent = buildAgentWithRegistry(client);
  const result = await agent.runTurn("hi", { outputSchema: InvoiceSchema });
  assert.equal(client.outputSchemaLastSeen, InvoiceSchema);
  assert.deepEqual(result.output, { vendor: "Acme", total: 99 });
});

test("runTurn terminates on structured output even mid-loop", async () => {
  // Step 1: model calls a real tool. Step 2: model calls the synthetic
  // respond tool. The agent should execute the real tool and then
  // terminate on the structured output.
  const client = new CapturingClient([
    {
      text: "Let me check first.",
      toolCalls: [
        { id: "1", name: "echo_tool", input: { value: "ping" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 5 },
    },
    {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      output: { vendor: "Acme", total: 42 },
      usage: { inputTokens: 5, outputTokens: 5 },
    },
  ]);
  const agent = buildAgentWithRegistry(client, [makeEchoTool()]);
  const result = await agent.runTurn("extract this", {
    outputSchema: InvoiceSchema,
  });
  assert.deepEqual(result.output, { vendor: "Acme", total: 42 });
  assert.equal(result.text, "");
});

test("runTurn returns no output when the model never calls the synthetic tool", async () => {
  const client = new CapturingClient([
    {
      text: "Hello there.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const agent = buildAgentWithRegistry(client);
  const result = await agent.runTurn("hi", { outputSchema: InvoiceSchema });
  assert.equal(result.output, undefined);
  assert.equal(result.text, "Hello there.");
});

test("runTurn ignores extra real-tool calls when output is set in the same step", async () => {
  // Some providers emit multi-tool steps. When the model commits to a
  // structured answer, side-effects in the same step are dropped
  // rather than executed in a way the model can't see the result of.
  let echoCalls = 0;
  const echoTool: ToolDefinition = {
    name: "echo_tool",
    description: "echo",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      echoCalls += 1;
      return "echoed";
    },
  };
  const client = new CapturingClient([
    {
      text: "",
      // The synthetic call has been stripped already; the real client's
      // extractor leaves only the side-effect call here. The agent
      // should NOT dispatch it because output is set.
      toolCalls: [{ id: "1", name: "echo_tool", input: {} }],
      stopReason: "tool_use",
      output: { vendor: "Acme", total: 10 },
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ]);
  const agent = buildAgentWithRegistry(client, [echoTool]);
  const result = await agent.runTurn("hi", { outputSchema: InvoiceSchema });
  assert.deepEqual(result.output, { vendor: "Acme", total: 10 });
  assert.equal(echoCalls, 0, "echo tool must not be executed once output is set");
});
