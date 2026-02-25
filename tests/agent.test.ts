import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { CodingAgent } from "../src/agent/agent.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolSchema,
} from "../src/agent/types.js";
import type { ToolDefinition } from "../src/agent/types.js";
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
    projectIndex,
  });

  await agent.runTurn("List the project structure");
  assert.ok(capturedSystem.includes("[Project Code Map]"));
  assert.ok(capturedSystem.includes("CodingAgent"));
});
