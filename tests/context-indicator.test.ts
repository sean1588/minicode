import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createRequestHandler } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import type { UiUpdate } from "@minicode/agent-sdk";
import type { ServerMessage } from "../src/serve/types.js";
import {
  CodingAgent,
  ToolRegistry,
} from "@minicode/agent-sdk";
import type {
  ModelClient,
  ModelResponse,
  SessionMessage,
  ToolSchema,
} from "@minicode/agent-sdk";
import { UiStore } from "../src/ui/state/ui-store.js";
import { createTestAgentConfig } from "./test-utils.js";

// ── Mock model client ──

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
    if (!next) throw new Error("No queued model response.");
    return next;
  }
}

// ── MockBridge for serve tests ──

class MockBridge extends AgentBridge {
  private _busy = false;
  private _contextTokens = 1200;
  private _maxContextTokens = 16000;

  constructor() {
    super(() => {}, false);
  }

  override isBusy(): boolean {
    return this._busy;
  }

  override getConfig() {
    return createTestAgentConfig("/tmp/test-workspace");
  }

  override getAgent() {
    const ctx = { contextTokens: this._contextTokens, maxContextTokens: this._maxContextTokens };
    return {
      getContextStatus: () => ctx,
    } as unknown as CodingAgent;
  }

  override async runTurn(message: string) {
    this._busy = true;
    this.emit({ type: "streaming_chunk", content: `Echo: ${message}` } as ServerMessage);
    this._busy = false;
    return { text: `Echo: ${message}`, usage: { inputTokens: 10, outputTokens: 5 } };
  }

  override async listSess() { return []; }
  override async saveSess() { return { id: "s", label: "l", createdAt: "", savedAt: "", messageCount: 0 }; }
  override async loadSess() { return null; }
  override hasIndex(): boolean { return false; }

  emit(msg: ServerMessage): void {
    for (const fn of (this as unknown as { listeners: Set<(msg: ServerMessage) => void> }).listeners) {
      fn(msg);
    }
  }

  setContextState(tokens: number, max: number): void {
    this._contextTokens = tokens;
    this._maxContextTokens = max;
  }
}

// ── Test harness ──

let activeServer: Server | undefined;

function startTestServer(bridge: MockBridge): Promise<string> {
  const handler = createRequestHandler(bridge);
  const server = createServer(handler);
  activeServer = server;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve(`http://127.0.0.1:${addr.port}`);
      }
    });
  });
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (activeServer) {
      activeServer.close(() => resolve());
      activeServer = undefined;
    } else {
      resolve();
    }
  });
}

afterEach(async () => {
  await stopTestServer();
});

// ── REST API: /api/context ──

test("GET /api/context returns context token status", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/context`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { contextTokens: number; maxContextTokens: number };
  assert.equal(body.contextTokens, 1200);
  assert.equal(body.maxContextTokens, 16000);
});

test("GET /api/context reflects updated context state", async () => {
  const bridge = new MockBridge();
  bridge.setContextState(8000, 16000);
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/context`);
  const body = (await res.json()) as { contextTokens: number; maxContextTokens: number };
  assert.equal(body.contextTokens, 8000);
  assert.equal(body.maxContextTokens, 16000);
});

// ── Agent emits context_status UiUpdate ──

test("agent emits context_status UiUpdate during turn", async () => {
  const config = createTestAgentConfig("/tmp/test-workspace");
  const modelClient = new SequenceModelClient([
    {
      text: "done",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ]);
  const toolRegistry = new ToolRegistry([]);

  const events: UiUpdate[] = [];
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
    onUiUpdate: (event: UiUpdate) => events.push(event),
  });

  await agent.runTurn("hello");

  const contextEvents = events.filter((e) => e.type === "context_status");
  assert.ok(contextEvents.length >= 1, "should emit at least one context_status event");

  const ev = contextEvents[0]!;
  assert.equal(ev.type, "context_status");
  assert.equal(typeof (ev as { contextTokens: number }).contextTokens, "number");
  assert.equal((ev as { maxContextTokens: number }).maxContextTokens, config.maxContextTokens);
});

test("agent context_status tokens increase as messages are added", async () => {
  const config = createTestAgentConfig("/tmp/test-workspace");
  const modelClient = new SequenceModelClient([
    {
      text: "first",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
    {
      text: "second",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ]);
  const toolRegistry = new ToolRegistry([]);

  const contextTokensPerTurn: number[] = [];
  const agent = new CodingAgent({
    config,
    modelClient,
    toolRegistry,
    onUiUpdate: (event: UiUpdate) => {
      if (event.type === "context_status") {
        contextTokensPerTurn.push((event as { contextTokens: number }).contextTokens);
      }
    },
  });

  await agent.runTurn("hello");
  await agent.runTurn("world");

  assert.equal(contextTokensPerTurn.length, 2);
  assert.ok(
    contextTokensPerTurn[1]! > contextTokensPerTurn[0]!,
    `context should grow: ${contextTokensPerTurn[0]} → ${contextTokensPerTurn[1]}`,
  );
});

// ── CodingAgent.getContextStatus() ──

test("agent getContextStatus returns current token estimate and max", async () => {
  const config = createTestAgentConfig("/tmp/test-workspace");
  const modelClient = new SequenceModelClient([
    {
      text: "done",
      toolCalls: [],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    },
  ]);
  const toolRegistry = new ToolRegistry([]);

  const agent = new CodingAgent({ config, modelClient, toolRegistry });

  // Before any turn, context should be empty
  const before = agent.getContextStatus();
  assert.equal(before.contextTokens, 0);
  assert.equal(before.maxContextTokens, config.maxContextTokens);

  await agent.runTurn("test message");

  // After a turn, context should have some tokens
  const after = agent.getContextStatus();
  assert.ok(after.contextTokens > 0, "context should have tokens after a turn");
  assert.equal(after.maxContextTokens, config.maxContextTokens);
});

// ── UiStore context status ──

test("UiStore tracks context status via setContextStatus", () => {
  const store = new UiStore();
  assert.equal(store.getState().contextTokens, 0);
  assert.equal(store.getState().maxContextTokens, 0);

  store.setContextStatus(5000, 40000);
  assert.equal(store.getState().contextTokens, 5000);
  assert.equal(store.getState().maxContextTokens, 40000);
});

test("UiStore context status updates trigger listeners", () => {
  const store = new UiStore();
  let notified = false;
  store.subscribe(() => { notified = true; });

  store.setContextStatus(1000, 16000);
  assert.ok(notified, "listener should have been called");
  assert.equal(store.getState().contextTokens, 1000);
});

test("UiStore reset clears context status", () => {
  const store = new UiStore();
  store.setContextStatus(5000, 40000);
  store.reset();
  assert.equal(store.getState().contextTokens, 0);
  assert.equal(store.getState().maxContextTokens, 0);
});
