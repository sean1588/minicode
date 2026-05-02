import assert from "node:assert/strict";
import { test } from "node:test";

import { CodingAgent } from "../src/agent/agent.js";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolDefinition,
  ToolSchema,
} from "../src/agent/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig } from "./test-utils.js";

class SequenceModelClient implements ModelClient {
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
  }): Promise<ModelResponse> {
    void params;
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No queued model response.");
    }
    return next;
  }
}

class RepeatingModelClient implements ModelClient {
  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    void params;
    return {
      text: "running tool",
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

function createEchoTool(): ToolDefinition {
  return {
    name: "echo_tool",
    description: "Echoes a value",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    },
    execute: async (input) => `echo:${String(input.value)}`,
  };
}

test("agent executes tool calls and returns final assistant text", async () => {
  const responses: ModelResponse[] = [
    {
      text: "I will use a tool first.",
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "ok" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 8 },
    },
    {
      text: "Done. Change applied.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 6 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Make a change");
  assert.equal(text, "Done. Change applied.");

  const messages = agent.getSession().getMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[2]?.role, "tool");
  assert.equal(messages[3]?.role, "assistant");
});

test("agent stops on repeated identical tool calls", async () => {
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new RepeatingModelClient(),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Do something");
  assert.match(text, /repeated identical tool calls/);
});

test("agent returns usage totals across steps", async () => {
  const responses: ModelResponse[] = [
    {
      text: "Step 1",
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "a" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    {
      text: "Final answer.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 200, outputTokens: 75 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const result = await agent.runTurn("Count tokens");
  assert.equal(result.usage?.inputTokens, 300);
  assert.equal(result.usage?.outputTokens, 125);
});

test("agent emits UiUpdate events", async () => {
  const responses: ModelResponse[] = [
    {
      text: "thinking about it",
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "hi" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "Done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];

  const events: Array<{ type: string }> = [];
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
    onUiUpdate: (event) => events.push(event),
  });

  await agent.runTurn("Test events");
  const types = events.map((e) => e.type);
  assert.ok(types.includes("step"));
  assert.ok(types.includes("thinking"));
  assert.ok(types.includes("tool_call_start"));
  assert.ok(types.includes("tool_call_end"));
});

test("agent returns fallback text when model returns empty response", async () => {
  const responses: ModelResponse[] = [
    {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 0 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Hello");
  assert.match(text, /no response or tool calls/);
});

test("agent respects maxSteps limit", async () => {
  const config = createTestAgentConfig("/tmp");
  config.maxSteps = 2;

  let callCount = 0;
  const infiniteClient: ModelClient = {
    async chat() {
      callCount += 1;
      return {
        text: `step ${callCount}`,
        toolCalls: [{ id: `tool-${callCount}`, name: "echo_tool", input: { value: String(callCount) } }],
        stopReason: "tool_use" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const agent = new CodingAgent({
    config,
    modelClient: infiniteClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Go forever");
  assert.match(text, /turn call limit/);
  assert.match(text, /Type "continue"/);
  assert.match(text, /maxSteps/);
  assert.equal(callCount, 2);
});

test("agent accepts getCodeMap callback", async () => {
  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: spyClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
    getCodeMap: () => ({
      text: "# Code Map\n- MyClass",
      shownCount: 1,
      totalCount: 1,
    }),
  });

  await agent.runTurn("Show code map");
  assert.ok(capturedSystem.includes("[Project Code Map]"));
  assert.ok(capturedSystem.includes("MyClass"));
});

test("agent omits code map when getCodeMap not provided", async () => {
  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "Done.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: spyClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  await agent.runTurn("Hello");
  assert.ok(!capturedSystem.includes("[Project Code Map]"));
});

test("beforeToolCall: allow lets the tool run normally", async () => {
  const responses: ModelResponse[] = [
    {
      text: "Calling tool",
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "ok" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "Done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
  const seen: string[] = [];
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
    beforeToolCall: async ({ name }) => {
      seen.push(name);
      return { outcome: "allow" };
    },
  });

  await agent.runTurn("Hello");

  assert.deepEqual(seen, ["echo_tool"]);
  const messages = agent.getSession().getMessages();
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.equal(
    toolMsg!.role === "tool" && toolMsg.content,
    "echo:ok",
    "tool result should be the actual output, not a deny message",
  );
});

test("beforeToolCall: deny short-circuits and feeds reason back to the model", async () => {
  const responses: ModelResponse[] = [
    {
      text: "Calling tool",
      toolCalls: [
        { id: "tool-1", name: "echo_tool", input: { value: "secret" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "Sorry, I can't proceed without permission.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];

  let executed = 0;
  const tool: ToolDefinition = {
    name: "echo_tool",
    description: "echo",
    inputSchema: { type: "object", properties: {}, required: [] },
    execute: async () => {
      executed += 1;
      return "should not run";
    },
  };

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([tool]),
    beforeToolCall: async () => ({
      outcome: "deny",
      reason: "user clicked deny",
    }),
  });

  await agent.runTurn("Hello");

  assert.equal(executed, 0, "underlying tool should never have been called");
  const toolMsg = agent
    .getSession()
    .getMessages()
    .find((m) => m.role === "tool");
  assert.ok(toolMsg);
  assert.match(
    toolMsg!.role === "tool" ? toolMsg.content : "",
    /denied by user.*user clicked deny/,
    "model should see the denial reason as the tool's result",
  );
});

test("beforeToolCall: hook receives the tool name and full input payload", async () => {
  const responses: ModelResponse[] = [
    {
      text: "Calling tool",
      toolCalls: [
        { id: "tool-1", name: "echo_tool", input: { value: "hello world" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "Done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];
  const captured: { name: string; input: Record<string, unknown> }[] = [];
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
    beforeToolCall: async (toolCall) => {
      captured.push({ name: toolCall.name, input: toolCall.input });
      return { outcome: "allow" };
    },
  });

  await agent.runTurn("Hello");

  assert.equal(captured.length, 1, "hook was invoked once");
  assert.equal(captured[0]!.name, "echo_tool");
  assert.deepEqual(captured[0]!.input, { value: "hello world" });
});
