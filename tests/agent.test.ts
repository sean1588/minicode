import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  CodingAgent,
  ToolRegistry,
} from "@sean.holung/minicode-sdk";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolDefinition,
  ToolSchema,
} from "@sean.holung/minicode-sdk";
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

class InfiniteToolModelClient implements ModelClient {
  private callCount = 0;

  getCalls(): number {
    return this.callCount;
  }

  async chat(params: {
    model: string;
    system: string;
    messages: SessionMessage[];
    tools: ToolSchema[];
    maxTokens: number;
  }): Promise<ModelResponse> {
    void params;
    this.callCount += 1;
    return {
      text: `step ${this.callCount}`,
      toolCalls: [{ id: `tool-${this.callCount}`, name: "echo_tool", input: { value: String(this.callCount) } }],
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

function createEditTool(): ToolDefinition {
  return {
    name: "edit_file",
    description: "Edits a file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: async (input) => `edited:${String(input.path)}`,
  };
}

function createRunCommandTool(): ToolDefinition {
  return {
    name: "run_command",
    description: "Runs a shell command",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
    execute: async (input) => `ran:${String(input.command)}`,
  };
}

function assertToolCallTranscriptIsComplete(messages: SessionMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !message.toolCalls?.length) {
      continue;
    }

    const toolCalls = message.toolCalls;
    for (let offset = 0; offset < toolCalls.length; offset += 1) {
      const toolCall = toolCalls[offset]!;
      const toolResult = messages[i + offset + 1];
      assert.equal(toolResult?.role, "tool");
      assert.equal(toolResult?.role === "tool" ? toolResult.toolCallId : undefined, toolCall.id);
    }
  }
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
  assertToolCallTranscriptIsComplete(agent.getSession().getMessages());
});

test("agent does not treat repeated validation commands after edits as a loop", async () => {
  const responses: ModelResponse[] = [
    {
      text: "test current state",
      toolCalls: [{ id: "run-1", name: "run_command", input: { command: "npm test" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "first edit",
      toolCalls: [{ id: "edit-1", name: "edit_file", input: { path: "app.ts", content: "one" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "test after first edit",
      toolCalls: [{ id: "run-2", name: "run_command", input: { command: "npm test" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "second edit",
      toolCalls: [{ id: "edit-2", name: "edit_file", input: { path: "app.ts", content: "two" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "test after second edit",
      toolCalls: [{ id: "run-3", name: "run_command", input: { command: "npm test" } }],
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

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([
      createEditTool(),
      createRunCommandTool(),
    ]),
  });

  const { text } = await agent.runTurn("Fix and test");

  assert.equal(text, "Done.");
  assertToolCallTranscriptIsComplete(agent.getSession().getMessages());
});

test("agent still stops on repeated identical mutations", async () => {
  const responses: ModelResponse[] = [
    {
      text: "first edit",
      toolCalls: [{ id: "edit-1", name: "edit_file", input: { path: "app.ts", content: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "second edit",
      toolCalls: [{ id: "edit-2", name: "edit_file", input: { path: "app.ts", content: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "third edit",
      toolCalls: [{ id: "edit-3", name: "edit_file", input: { path: "app.ts", content: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEditTool()]),
  });

  const { text } = await agent.runTurn("Edit repeatedly");

  assert.match(text, /repeated identical tool calls/);
  assertToolCallTranscriptIsComplete(agent.getSession().getMessages());
});

test("agent tells the user how to continue when the turn call limit is reached", async () => {
  const config = createTestAgentConfig("/tmp");
  config.maxSteps = 2;
  const modelClient = new InfiniteToolModelClient();

  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Keep working");
  assert.match(text, /turn call limit/);
  assert.match(text, /Type "continue"/);
  assert.match(text, /Settings/);
  assert.equal(modelClient.getCalls(), 2);
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
