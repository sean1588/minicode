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

test("soft loop guard lets the model recover after a single nudge", async () => {
  // Three identical echo calls trip the guard once (skip + nudge + reset
  // the offending fingerprint), the model redirects on the next turn,
  // and the turn completes normally. Regression check against the prior
  // terminate-on-first-fire behavior, which would have hard-stopped the
  // turn before the redirect message could land.
  const responses: ModelResponse[] = [
    {
      text: "first call",
      toolCalls: [{ id: "echo-1", name: "echo_tool", input: { value: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "second call",
      toolCalls: [{ id: "echo-2", name: "echo_tool", input: { value: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "third call (will be nudged)",
      toolCalls: [{ id: "echo-3", name: "echo_tool", input: { value: "same" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "redirect after nudge",
      toolCalls: [{ id: "echo-4", name: "echo_tool", input: { value: "different" } }],
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
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Do something");
  assert.equal(text, "Done.");

  const toolMessages = agent
    .getSession()
    .getMessages()
    .filter((m) => m.role === "tool");
  const nudges = toolMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("loop guard"),
  );
  assert.equal(nudges.length, 1, "exactly one loop-guard nudge should fire");
  assert.equal(
    toolMessages.length,
    4,
    "the 3rd echo should be suppressed (nudge) and the 4th should execute normally",
  );
});

test("agent tolerates 3 identical search calls before tripping loop guard", async () => {
  // search has a relaxed threshold of 4 (vs 3 for other tools) — regex
  // exploration legitimately emits pattern variants and may revisit one
  // before converging. Verify the agent executes the underlying tool 3
  // times before the 4th repeat triggers the soft guard (skip + nudge),
  // and that the nudge surfaces as the suppressed call's tool result.
  const searchTool: ToolDefinition = {
    name: "search",
    description: "Search the workspace",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    execute: async () => "no matches",
  };

  class RepeatingSearchClient implements ModelClient {
    private callIndex = 0;
    async chat(): Promise<ModelResponse> {
      this.callIndex += 1;
      // Emit one identical search call per turn so the loop guard sees a
      // fingerprint repeat each step rather than batching them together.
      return {
        text: "searching",
        toolCalls: [
          { id: `tool-${this.callIndex}`, name: "search", input: { pattern: "x" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
  }

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new RepeatingSearchClient(),
    toolRegistry: new ToolRegistry([searchTool]),
  });

  await agent.runTurn("Do something");
  // Find the first loop-guard nudge in the transcript and count search
  // executions that happened before it. Threshold = 4 means the search
  // tool should have run 3 times before the 4th repeat was suppressed.
  // If search had used the default threshold of 3, we would see only 2
  // executions before the first nudge.
  const messages = agent.getSession().getMessages();
  const firstNudgeIndex = messages.findIndex(
    (m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("loop guard"),
  );
  assert.ok(firstNudgeIndex >= 0, "soft loop guard should inject at least one nudge tool result");
  const executionsBeforeFirstNudge = messages
    .slice(0, firstNudgeIndex)
    .filter((m) => m.role === "tool" && typeof m.content === "string" && m.content.includes("no matches"))
    .length;
  assert.equal(
    executionsBeforeFirstNudge,
    3,
    "search threshold = 4 should let the tool run 3 times before the 4th repeat trips the guard",
  );
});

test("run_command fingerprint collapses comment-only bodies so '# END' streaks fire the guard", async () => {
  // Regression: gemini-3-flash on django-16527 timed out wrapping
  // "# Final status: ...", "# END", "# Exiting" in run_command calls
  // because it couldn't return text without a tool call. Each body was
  // different so verbatim hashing never tripped the guard. Normalising
  // strips comment-only lines to the empty string — three such calls
  // (default threshold = 3) now trip the soft guard immediately.
  const runCommandTool: ToolDefinition = {
    name: "run_command",
    description: "Run a shell command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: async () => "ok",
  };

  const responses: ModelResponse[] = [
    {
      text: "step 1",
      toolCalls: [{ id: "c1", name: "run_command", input: { command: "# Final status: done." } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "step 2",
      toolCalls: [{ id: "c2", name: "run_command", input: { command: "# END" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "step 3",
      toolCalls: [{ id: "c3", name: "run_command", input: { command: "# Exiting." } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    {
      text: "OK I'm actually done.",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([runCommandTool]),
  });

  await agent.runTurn("do something");
  const toolMessages = agent
    .getSession()
    .getMessages()
    .filter((m) => m.role === "tool");
  const nudges = toolMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("loop guard"),
  );
  assert.equal(
    nudges.length,
    1,
    "the 3rd comment-only run_command should fire the soft loop guard exactly once",
  );
});

test("run_command fingerprint normalizes comment headers + whitespace so near-identical greps collapse", async () => {
  // Regression: gemini-3-flash on django-16527 ran three "# Final check
  // of the modified files\ngrep -A 5 ..." calls that differed only in
  // trailing whitespace. Verbatim hashing missed the duplication.
  const runCommandTool: ToolDefinition = {
    name: "run_command",
    description: "Run a shell command",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: async () => "no matches",
  };

  const greps = [
    '# Final check of the modified files across the project.\ngrep -A 5 "show_save_as_new" django/contrib/',
    '# Final check of the modified files across the project.\ngrep   -A 5  "show_save_as_new"  django/contrib/  ',
    '# Final check of the modified files across the project.\n# (one more time)\ngrep -A 5 "show_save_as_new" django/contrib/',
  ];
  const responses: ModelResponse[] = greps.map((command, index) => ({
    text: `step ${index + 1}`,
    toolCalls: [{ id: `c${index + 1}`, name: "run_command", input: { command } }],
    stopReason: "tool_use" as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  responses.push({
    text: "Done.",
    toolCalls: [],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([runCommandTool]),
  });

  await agent.runTurn("inspect");
  const toolMessages = agent
    .getSession()
    .getMessages()
    .filter((m) => m.role === "tool");
  const nudges = toolMessages.filter(
    (m) => typeof m.content === "string" && m.content.includes("loop guard"),
  );
  assert.equal(
    nudges.length,
    1,
    "the 3rd whitespace-only-variant grep should fire the soft loop guard exactly once",
  );
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

test("agent surfaces reasoningContent when model collapses to pure thinking", async () => {
  // Pure-thinking collapse: Gemini-2.5/3 sometimes burn their full
  // reasoning budget and return empty content + empty tool_calls but
  // non-empty reasoning. Before this fix the agent replaced everything
  // with the generic "no response" fallback. Now the reasoning is
  // surfaced so the trace / UI can see what the model thought.
  const responses: ModelResponse[] = [
    {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      reasoningContent:
        "I should call edit_file on foo.py to replace the bad default.",
      usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 1200 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Hello");
  assert.match(text, /model produced only reasoning content/i);
  assert.match(text, /edit_file on foo\.py/);
  assert.doesNotMatch(text, /no response or tool calls/);
});

test("agent truncates oversized reasoning content on pure-thinking collapse", async () => {
  // Guard against dumping a 50KB reasoning blob verbatim into the chat.
  // Cap is ~8K chars + a truncation marker.
  const huge = "x".repeat(20000);
  const responses: ModelResponse[] = [
    {
      text: "",
      toolCalls: [],
      stopReason: "end_turn",
      reasoningContent: huge,
      usage: { inputTokens: 10, outputTokens: 0, reasoningTokens: 5000 },
    },
  ];

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: new SequenceModelClient(responses),
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const { text } = await agent.runTurn("Hello");
  assert.match(text, /reasoning truncated/i);
  assert.match(text, /12000 chars omitted/);
  assert.ok(text.length < huge.length, "rescue text should be smaller than raw reasoning");
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

function createSummarizerClient(captured: string[]): ModelClient {
  return {
    async chat(params) {
      captured.push(params.model);
      return {
        text: "Summary",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

function seedCompactableSession(agent: CodingAgent): void {
  // keepRecentMessages defaults to 2 in this helper's caller; seed 10
  // messages so there's something to summarize.
  for (let i = 0; i < 5; i += 1) {
    agent.getSession().addMessage({ role: "user", content: `msg ${i}` });
    agent.getSession().addMessage({ role: "assistant", content: `reply ${i}` });
  }
}

test("compactContext defaults to LLM compaction with the agent's primary model", async () => {
  const captured: string[] = [];
  const agent = new CodingAgent({
    config: {
      ...createTestAgentConfig("/tmp"),
      model: "primary-model",
      keepRecentMessages: 2,
    },
    modelClient: createSummarizerClient(captured),
    toolRegistry: new ToolRegistry([]),
  });
  seedCompactableSession(agent);

  const result = await agent.compactContext();

  assert.ok(result, "compactContext should produce a result");
  assert.equal(result!.method, "llm");
  assert.deepEqual(
    captured,
    ["primary-model"],
    "summarizer should have been called with the agent's primary model",
  );
});

test("compactContext uses compactionModel override when set", async () => {
  const captured: string[] = [];
  const agent = new CodingAgent({
    config: {
      ...createTestAgentConfig("/tmp"),
      model: "primary-model",
      compactionModel: "cheap-summarizer",
      keepRecentMessages: 2,
    },
    modelClient: createSummarizerClient(captured),
    toolRegistry: new ToolRegistry([]),
  });
  seedCompactableSession(agent);

  await agent.compactContext();

  assert.deepEqual(
    captured,
    ["cheap-summarizer"],
    "compactionModel override should win over the primary model",
  );
});

test("agent passes cacheableSystem: true by default and accumulates cachedInputTokens across steps", async () => {
  const cacheableSystemFlags: Array<boolean | undefined> = [];
  const stepResponses: ModelResponse[] = [
    {
      text: "Step 1",
      toolCalls: [{ id: "t1", name: "echo_tool", input: { value: "a" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
    },
    {
      text: "Final",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 110, outputTokens: 10, cachedInputTokens: 95 },
    },
  ];
  const client: ModelClient = {
    async chat(params) {
      cacheableSystemFlags.push(
        (params as { cacheableSystem?: boolean }).cacheableSystem,
      );
      const next = stepResponses.shift();
      if (!next) throw new Error("ran out of queued responses");
      return next;
    },
  };

  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: client,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const result = await agent.runTurn("Hello");

  assert.deepEqual(
    cacheableSystemFlags,
    [true, true],
    "agent should default to cacheableSystem: true on every step when enableDynamicPrompt is off",
  );
  assert.equal(result.usage?.cachedInputTokens, 175, "should sum 80 + 95 across the turn");
  assert.equal(result.usage?.inputTokens, 210);
});

test("agent uses static prompt when enableDynamicPrompt is absent from config", async () => {
  // Regression test for PR #138's incomplete fix. The CLI's loadAgentConfig
  // explicitly sets enableDynamicPrompt: false, but external SDK consumers
  // and the benchmark script were leaving the field undefined. Previously
  // the agent used `!== false` semantics for the dynamic check, which
  // routed `undefined` to `true` — so any consumer relying on the
  // documented default (off) silently got dynamic prompts on.
  //
  // After fix: an absent field must route to static prompts (built once,
  // reused across steps), matching what the CLI/serve callers already do.
  const buildSystemPromptCalls: number[] = [];
  let callIndex = 0;

  const stepResponses = [
    {
      text: "Step 1",
      toolCalls: [{ id: "t1", name: "echo_tool", input: { value: "a" } }],
      stopReason: "tool_use" as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    {
      text: "Step 2",
      toolCalls: [{ id: "t2", name: "echo_tool", input: { value: "b" } }],
      stopReason: "tool_use" as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
    {
      text: "Final",
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  ];

  const client: ModelClient = {
    async chat() {
      const next = stepResponses[callIndex++];
      if (!next) throw new Error("ran out of queued responses");
      return next;
    },
  };

  // createTestAgentConfig deliberately does NOT set enableDynamicPrompt,
  // mirroring the benchmark + external-consumer code path.
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: client,
    toolRegistry: new ToolRegistry([createEchoTool()]),
    buildSystemPrompt: () => {
      buildSystemPromptCalls.push(callIndex);
      return "STATIC PROMPT";
    },
  });

  await agent.runTurn("Hello");

  assert.equal(
    buildSystemPromptCalls.length,
    1,
    "absent enableDynamicPrompt should default to static — buildSystemPrompt must run exactly once across multiple steps, not on every turn",
  );
});

test("agent passes cacheableSystem: false when enableDynamicPrompt is enabled", async () => {
  const cacheableSystemFlags: Array<boolean | undefined> = [];
  const client: ModelClient = {
    async chat(params) {
      cacheableSystemFlags.push(
        (params as { cacheableSystem?: boolean }).cacheableSystem,
      );
      return {
        text: "Done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 5 },
      };
    },
  };

  const agent = new CodingAgent({
    config: { ...createTestAgentConfig("/tmp"), enableDynamicPrompt: true },
    modelClient: client,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  await agent.runTurn("Hello");

  assert.deepEqual(
    cacheableSystemFlags,
    [false],
    "dynamic prompts rebuild the system on every step, so caching it would just burn cache writes",
  );
});

test("agent omits cachedInputTokens when no step reported any", async () => {
  const client: ModelClient = {
    async chat() {
      return {
        text: "Done",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 5 },
      };
    },
  };
  const agent = new CodingAgent({
    config: createTestAgentConfig("/tmp"),
    modelClient: client,
    toolRegistry: new ToolRegistry([createEchoTool()]),
  });

  const result = await agent.runTurn("Hello");

  assert.equal(
    result.usage?.cachedInputTokens,
    undefined,
    "no cache hits should mean no cachedInputTokens field on the totals",
  );
});

test("buildSystemPrompt override replaces the default builder", async () => {
  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "ok",
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
    buildSystemPrompt: () => "CUSTOM PROMPT — nothing else",
  });

  await agent.runTurn("Hello");

  assert.equal(capturedSystem, "CUSTOM PROMPT — nothing else");
  assert.ok(
    !capturedSystem.includes("[Identity]"),
    "default coding-agent identity should not appear when overridden",
  );
});

test("buildSystemPrompt override receives config, tools, and codeMap context", async () => {
  const seenCtx: Array<{ workspaceRoot: string; toolNames: string[]; hasCodeMap: boolean }> = [];
  const spyClient: ModelClient = {
    async chat() {
      return {
        text: "ok",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const agent = new CodingAgent({
    config: { ...createTestAgentConfig("/some/workspace"), enableDynamicPrompt: true },
    modelClient: spyClient,
    toolRegistry: new ToolRegistry([createEchoTool()]),
    getCodeMap: () => ({ text: "# map", shownCount: 1, totalCount: 1 }),
    buildSystemPrompt: (ctx) => {
      seenCtx.push({
        workspaceRoot: ctx.config.workspaceRoot,
        toolNames: ctx.tools.map((t) => t.name),
        hasCodeMap: ctx.codeMap !== undefined,
      });
      return "x";
    },
  });

  await agent.runTurn("Hi");

  assert.equal(seenCtx.length, 1);
  assert.equal(seenCtx[0]!.workspaceRoot, "/some/workspace");
  assert.deepEqual(seenCtx[0]!.toolNames, ["echo_tool"]);
  assert.equal(seenCtx[0]!.hasCodeMap, true);
});

test("buildSystemPrompt override may return a Promise (async builder)", async () => {
  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "ok",
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
    buildSystemPrompt: async () => {
      // Simulate fetching context async (e.g. RAG, git status, on-disk prefs).
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "ASYNC PROMPT";
    },
  });

  await agent.runTurn("Hello");

  assert.equal(capturedSystem, "ASYNC PROMPT");
});

test("getSystemPromptSuffix still appends after the buildSystemPrompt override", async () => {
  let capturedSystem = "";
  const spyClient: ModelClient = {
    async chat(params) {
      capturedSystem = params.system;
      return {
        text: "ok",
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
    buildSystemPrompt: () => "BASE",
    getSystemPromptSuffix: () => "EXTRA",
  });

  await agent.runTurn("Hello");

  assert.equal(
    capturedSystem,
    "BASE\n\nEXTRA",
    "suffix should append regardless of which builder produced the base",
  );
});
