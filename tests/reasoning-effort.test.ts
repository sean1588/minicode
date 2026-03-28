import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OpenAICompatibleModelClient,
  CodingAgent,
  Session,
  ToolRegistry,
} from "@minicode/agent-sdk";
import type { AgentConfig, ModelResponse, ReasoningEffort } from "@minicode/agent-sdk";
import { createTestAgentConfig } from "./test-utils.js";
import { loadAgentConfig } from "../src/agent/config.js";

// ---------------------------------------------------------------------------
// Config: REASONING_EFFORT env var
// ---------------------------------------------------------------------------

test("loadAgentConfig parses REASONING_EFFORT env var", async () => {
  const prev = process.env.REASONING_EFFORT;
  try {
    process.env.REASONING_EFFORT = "high";
    const config = await loadAgentConfig("/tmp");
    assert.equal(config.reasoningEffort, "high");
  } finally {
    if (prev === undefined) {
      delete process.env.REASONING_EFFORT;
    } else {
      process.env.REASONING_EFFORT = prev;
    }
  }
});

test("loadAgentConfig ignores invalid REASONING_EFFORT values", async () => {
  const prev = process.env.REASONING_EFFORT;
  try {
    process.env.REASONING_EFFORT = "ultra";
    const config = await loadAgentConfig("/tmp");
    assert.equal(config.reasoningEffort, undefined);
  } finally {
    if (prev === undefined) {
      delete process.env.REASONING_EFFORT;
    } else {
      process.env.REASONING_EFFORT = prev;
    }
  }
});

test("loadAgentConfig leaves reasoningEffort undefined when env var is unset", async () => {
  const prev = process.env.REASONING_EFFORT;
  try {
    delete process.env.REASONING_EFFORT;
    const config = await loadAgentConfig("/tmp");
    assert.equal(config.reasoningEffort, undefined);
  } finally {
    if (prev === undefined) {
      delete process.env.REASONING_EFFORT;
    } else {
      process.env.REASONING_EFFORT = prev;
    }
  }
});

test("loadAgentConfig normalizes REASONING_EFFORT case", async () => {
  const prev = process.env.REASONING_EFFORT;
  try {
    process.env.REASONING_EFFORT = "MEDIUM";
    const config = await loadAgentConfig("/tmp");
    assert.equal(config.reasoningEffort, "medium");
  } finally {
    if (prev === undefined) {
      delete process.env.REASONING_EFFORT;
    } else {
      process.env.REASONING_EFFORT = prev;
    }
  }
});

// ---------------------------------------------------------------------------
// OpenAI-compatible client: reasoning field in request body
// ---------------------------------------------------------------------------

test("openai-compatible client includes reasoning field when reasoningEffort is set", async () => {
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Hello", tool_calls: [] },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
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
    system: "System",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 1024,
    reasoningEffort: "high",
  });

  const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.deepEqual(parsed.reasoning, { effort: "high" });
});

test("openai-compatible client omits reasoning field when reasoningEffort is not set", async () => {
  let capturedBody = "";

  const fetchImpl: typeof fetch = async (_input, init) => {
    capturedBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Hello", tool_calls: [] },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
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
    system: "System",
    messages: [{ role: "user", content: "Hi" }],
    tools: [],
    maxTokens: 1024,
  });

  const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
  assert.equal(parsed.reasoning, undefined);
});

test("openai-compatible client sends all valid effort levels", async () => {
  const levels: ReasoningEffort[] = ["xhigh", "high", "medium", "low", "minimal", "none"];

  for (const level of levels) {
    let capturedBody = "";

    const fetchImpl: typeof fetch = async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Ok", tool_calls: [] },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
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
      system: "System",
      messages: [{ role: "user", content: "Hi" }],
      tools: [],
      maxTokens: 1024,
      reasoningEffort: level,
    });

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.deepEqual(parsed.reasoning, { effort: level }, `Expected reasoning.effort="${level}"`);
  }
});

// ---------------------------------------------------------------------------
// CodingAgent: get/set reasoning effort
// ---------------------------------------------------------------------------

test("CodingAgent.getReasoningEffort returns config value", () => {
  const config: AgentConfig = {
    ...createTestAgentConfig("/tmp"),
    reasoningEffort: "medium",
  };

  const mockClient = {
    async chat(): Promise<ModelResponse> {
      return {
        text: "done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  const agent = new CodingAgent({
    config,
    modelClient: mockClient,
    toolRegistry: new ToolRegistry([]),
  });

  assert.equal(agent.getReasoningEffort(), "medium");
});

test("CodingAgent.setReasoningEffort updates reasoning effort", () => {
  const config = createTestAgentConfig("/tmp");

  const mockClient = {
    async chat(): Promise<ModelResponse> {
      return {
        text: "done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  const agent = new CodingAgent({
    config,
    modelClient: mockClient,
    toolRegistry: new ToolRegistry([]),
  });

  assert.equal(agent.getReasoningEffort(), undefined);

  agent.setReasoningEffort("high");
  assert.equal(agent.getReasoningEffort(), "high");

  agent.setReasoningEffort("none");
  assert.equal(agent.getReasoningEffort(), "none");

  agent.setReasoningEffort(undefined);
  assert.equal(agent.getReasoningEffort(), undefined);
});

// ---------------------------------------------------------------------------
// Agent loop passes reasoningEffort to model client
// ---------------------------------------------------------------------------

test("agent loop passes reasoningEffort to model client chat call", async () => {
  let capturedReasoningEffort: ReasoningEffort | undefined;

  const config: AgentConfig = {
    ...createTestAgentConfig("/tmp"),
    reasoningEffort: "low",
  };

  const mockClient = {
    async chat(params: { reasoningEffort?: ReasoningEffort }): Promise<ModelResponse> {
      capturedReasoningEffort = params.reasoningEffort;
      return {
        text: "Response",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  const agent = new CodingAgent({
    config,
    modelClient: mockClient,
    toolRegistry: new ToolRegistry([]),
  });

  await agent.runTurn("Hello");
  assert.equal(capturedReasoningEffort, "low");
});

test("agent loop omits reasoningEffort when not configured", async () => {
  let capturedParams: Record<string, unknown> = {};

  const config = createTestAgentConfig("/tmp");

  const mockClient = {
    async chat(params: Record<string, unknown>): Promise<ModelResponse> {
      capturedParams = params;
      return {
        text: "Response",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };

  const agent = new CodingAgent({
    config,
    modelClient: mockClient,
    toolRegistry: new ToolRegistry([]),
  });

  await agent.runTurn("Hello");
  assert.equal(capturedParams.reasoningEffort, undefined);
});
