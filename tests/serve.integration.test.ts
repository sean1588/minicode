import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { createRequestHandler } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import type { ServerMessage } from "../src/serve/types.js";
import { createTestAgentConfig } from "./test-utils.js";

/**
 * Lightweight AgentBridge subclass for testing.
 * Overrides all public methods so no real config/agent/index is needed.
 */
class MockBridge extends AgentBridge {
  private _busy = false;
  turnHistory: string[] = [];

  constructor() {
    super(() => {}, false);
  }

  override isBusy(): boolean {
    return this._busy;
  }

  override getConfig() {
    return createTestAgentConfig("/tmp/test-workspace");
  }

  override async runTurn(message: string) {
    if (this._busy) throw new Error("busy");
    this._busy = true;
    this.turnHistory.push(message);
    // Simulate streaming by emitting events via the listener system
    this.emit({ type: "streaming_chunk", content: `Echo: ${message}` } as ServerMessage);
    this._busy = false;
    return {
      text: `Echo: ${message}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  /** Expose the private emit for test streaming simulation. */
  emit(msg: ServerMessage): void {
    // Call listeners registered via addListener
    for (const fn of (this as unknown as { listeners: Set<(msg: ServerMessage) => void> }).listeners) {
      fn(msg);
    }
  }

  override async listSess() {
    return [
      {
        id: "sess-1",
        label: "test-session",
        createdAt: "2026-01-01T00:00:00.000Z",
        savedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 3,
      },
    ];
  }

  override async saveSess(label?: string) {
    return {
      id: "sess-new",
      label: label ?? "auto-label",
      createdAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
    };
  }

  override async loadSess(label: string) {
    if (label === "nonexistent") return null;
    return { session: {} as never, label };
  }

  setBusy(busy: boolean): void {
    this._busy = busy;
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

// ── REST API tests ──

test("GET /api/status returns status and config info", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { status: string; workspace: string; model: string; provider: string };
  assert.equal(body.status, "ready");
  assert.equal(body.workspace, "/tmp/test-workspace");
  assert.equal(body.model, "test-model");
  assert.equal(body.provider, "anthropic");
});

test("GET /api/status returns busy when agent is busy", async () => {
  const bridge = new MockBridge();
  bridge.setBusy(true);
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/status`);
  const body = (await res.json()) as { status: string };
  assert.equal(body.status, "busy");
});

test("GET /api/config returns formatted config", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { config: string };
  assert.ok(body.config.includes("workspaceRoot"));
  assert.ok(body.config.includes("test-model"));
});

test("GET /api/sessions returns session list", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { sessions: Array<{ label: string }> };
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0]!.label, "test-session");
});

test("POST /api/sessions/save saves a session", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "my-save" }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { label: string };
  assert.equal(body.label, "my-save");
});

test("POST /api/sessions/load returns 404 for unknown session", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "nonexistent" }),
  });
  assert.equal(res.status, 404);
});

test("POST /api/sessions/load returns success for known session", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "test-session" }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { label: string };
  assert.equal(body.label, "test-session");
});

test("POST /api/chat returns agent response", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { text: string; usage: { inputTokens: number; outputTokens: number } };
  assert.equal(body.text, "Echo: hello");
  assert.equal(body.usage.inputTokens, 10);
  assert.equal(body.usage.outputTokens, 5);
});

test("POST /api/chat returns 400 when message is missing", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("POST /api/chat returns 429 when agent is busy", async () => {
  const bridge = new MockBridge();
  bridge.setBusy(true);
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(res.status, 429);
});

// ── OpenAI-compatible API tests ──

test("GET /v1/models returns minicode-agent model", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/models`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0]!.id, "minicode-agent");
  assert.equal(body.data[0]!.owned_by, "minicode");
});

test("POST /v1/chat/completions non-streaming returns OpenAI-format response", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minicode-agent",
      messages: [{ role: "user", content: "list files" }],
    }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    id: string;
    object: string;
    model: string;
    choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  assert.ok(body.id.startsWith("chatcmpl-"));
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "minicode-agent");
  assert.equal(body.choices.length, 1);
  assert.equal(body.choices[0]!.message.role, "assistant");
  assert.equal(body.choices[0]!.message.content, "Echo: list files");
  assert.equal(body.choices[0]!.finish_reason, "stop");
  assert.equal(body.usage.prompt_tokens, 10);
  assert.equal(body.usage.completion_tokens, 5);
  assert.equal(body.usage.total_tokens, 15);
});

test("POST /v1/chat/completions returns 400 for empty messages", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "minicode-agent", messages: [] }),
  });
  assert.equal(res.status, 400);
});

test("POST /v1/chat/completions returns 400 for no user message", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minicode-agent",
      messages: [{ role: "system", content: "You are helpful" }],
    }),
  });
  assert.equal(res.status, 400);
});

test("POST /v1/chat/completions returns 429 when busy", async () => {
  const bridge = new MockBridge();
  bridge.setBusy(true);
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minicode-agent",
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  assert.equal(res.status, 429);
});

test("POST /v1/chat/completions streaming returns SSE chunks", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "minicode-agent",
      messages: [{ role: "user", content: "stream test" }],
      stream: true,
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const text = await res.text();
  const lines = text.split("\n").filter((l) => l.startsWith("data: "));

  // Should have at least: role chunk, finish chunk, [DONE]
  assert.ok(lines.length >= 2, `Expected at least 2 data lines, got ${lines.length}`);

  // First chunk should have role
  const firstChunk = JSON.parse(lines[0]!.slice(6)) as { choices: Array<{ delta: { role?: string } }> };
  assert.equal(firstChunk.choices[0]!.delta.role, "assistant");

  // Last data line before [DONE] should have finish_reason
  const lastDataLine = lines.filter((l) => l !== "data: [DONE]").pop()!;
  const lastChunk = JSON.parse(lastDataLine.slice(6)) as { choices: Array<{ finish_reason: string | null }> };
  assert.equal(lastChunk.choices[0]!.finish_reason, "stop");

  // Should end with [DONE]
  assert.ok(text.includes("data: [DONE]"));
});

// ── Static file serving tests ──

test("GET / serves index.html", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html");

  const html = await res.text();
  assert.ok(html.includes("minicode"));
});

test("GET /style.css serves CSS file", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/style.css`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/css");
});

test("GET /app.js serves JS file", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/javascript");
});

test("GET /nonexistent returns 404", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/nonexistent.html`);
  assert.equal(res.status, 404);
});

// ── CLI args tests ──

test("parseCliArgs parses serve subcommand", async () => {
  const { parseCliArgs } = await import("../src/cli/args.js");
  const parsed = parseCliArgs(["node", "minicode", "serve"]);
  assert.equal(parsed.serve, true);
  assert.equal(parsed.port, 4567);
});

test("parseCliArgs parses serve with --port", async () => {
  const { parseCliArgs } = await import("../src/cli/args.js");
  const parsed = parseCliArgs(["node", "minicode", "serve", "--port", "8080"]);
  assert.equal(parsed.serve, true);
  assert.equal(parsed.port, 8080);
});

test("parseCliArgs parses serve with --port=value", async () => {
  const { parseCliArgs } = await import("../src/cli/args.js");
  const parsed = parseCliArgs(["node", "minicode", "serve", "--port=9090"]);
  assert.equal(parsed.serve, true);
  assert.equal(parsed.port, 9090);
});

test("validateCliArgs rejects serve with --oneshot", async () => {
  const { validateCliArgs, CliUsageError } = await import("../src/cli/args.js");
  assert.throws(
    () => validateCliArgs({ verbose: false, oneshot: true, json: false, serve: true, port: 4567, task: "test" }),
    (err: unknown) => err instanceof CliUsageError,
  );
});
