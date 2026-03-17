import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  CodingAgent,
  ToolRegistry,
} from "@minicode/agent-sdk";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolDefinition,
  ToolSchema,
} from "@minicode/agent-sdk";
import { buildProjectIndex } from "../src/indexer/project-index.js";
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

test("agent omits code map when projectIndex is not provided", async () => {
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

test("agent caps thinking text in session but preserves final response", async () => {
  const longThinking = "I need to analyze this carefully. ".repeat(20); // ~660 chars, well over 200
  const finalResponse = "Here is the complete and detailed answer that should not be truncated at all. ".repeat(10); // ~780 chars

  const responses: ModelResponse[] = [
    {
      text: longThinking,
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "ok" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 8 },
    },
    {
      text: finalResponse,
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

  const { text } = await agent.runTurn("Do something complex");

  const messages = agent.getSession().getMessages();

  // Thinking message (assistant with toolCalls) should be capped at ~200 chars + "..."
  const thinkingMsg = messages[1];
  assert.equal(thinkingMsg?.role, "assistant");
  assert.ok(
    thinkingMsg?.role === "assistant" && thinkingMsg.content.length <= 204,
    `Thinking should be capped but was ${thinkingMsg?.role === "assistant" ? thinkingMsg.content.length : "?"} chars`,
  );
  assert.ok(
    thinkingMsg?.role === "assistant" && thinkingMsg.content.endsWith("..."),
    "Capped thinking should end with ellipsis",
  );

  // Final response (assistant without toolCalls) should be preserved in full
  const finalMsg = messages[3];
  assert.equal(finalMsg?.role, "assistant");
  assert.equal(text, finalResponse);
  assert.ok(
    finalMsg?.role === "assistant" && finalMsg.content === finalResponse,
    "Final response should not be truncated",
  );
});

test("agent preserves short thinking text without capping", async () => {
  const shortThinking = "Let me check.";

  const responses: ModelResponse[] = [
    {
      text: shortThinking,
      toolCalls: [{ id: "tool-1", name: "echo_tool", input: { value: "ok" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 8 },
    },
    {
      text: "Done.",
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

  await agent.runTurn("Quick task");

  const messages = agent.getSession().getMessages();
  const thinkingMsg = messages[1];
  assert.equal(thinkingMsg?.role, "assistant");
  assert.ok(
    thinkingMsg?.role === "assistant" && thinkingMsg.content === shortThinking,
    "Short thinking should be preserved verbatim",
  );
});

test("agent includes code map in system prompt when projectIndex is provided", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const projectIndex = await buildProjectIndex(root);

  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "Task complete.",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const agent = new CodingAgent({
    config: createTestAgentConfig(root),
    modelClient: spyClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
    getCodeMap: () => projectIndex.getCodeMap(),
  });

  await agent.runTurn("List the project structure");
  assert.ok(capturedSystem.includes("[Project Code Map]"));
  assert.ok(capturedSystem.includes("CodingAgent"));
});
