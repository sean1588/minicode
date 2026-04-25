import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StructuralAnalysisReport } from "../src/analysis/structural-analysis.js";
import { createRequestHandler, shutdownServe } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import { Session, type UiUpdate } from "@minicode/agent-sdk";
import type { IndexedSymbol } from "../src/indexer/types.js";
import type { ServerMessage } from "../src/serve/types.js";
import { DuplicateSessionLabelError } from "../src/session/session-store.js";
import { createTestAgentConfig } from "./test-utils.js";

/**
 * Lightweight AgentBridge subclass for testing.
 * Overrides all public methods so no real config/agent/index is needed.
 */
class MockBridge extends AgentBridge {
  private _busy = false;
  private _currentSessionId = "sess-1";
  private readonly _baseConfig = createTestAgentConfig("/tmp/test-workspace");
  private readonly _config = createTestAgentConfig("/tmp/test-workspace");
  turnHistory: string[] = [];
  openRouterKey: string | undefined;
  openRouterSessionActive = false;
  openAiCompatibleApiKey: string | undefined;
  openAiCompatibleSessionActive = false;
  refreshIndexCount = 0;
  deletedSessionIds: string[] = [];

  constructor() {
    super(() => {}, false);
  }

  override isBusy(): boolean {
    return this._busy;
  }

  override getConfig() {
    return this._config;
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
    const session = new Session("sess-1");
    session.addMessage({
      role: "user",
      content: "[Conversation Summary — earlier messages were compacted to save context]\nOlder summary",
    });
    for (let i = 1; i <= 11; i += 1) {
      session.addMessage({
        role: i % 2 === 0 ? "assistant" : "user",
        content: `message-${i}`,
      });
    }
    return { session, label };
  }

  override async deleteSess(sessionId: string) {
    if (sessionId !== "sess-1") {
      return false;
    }
    this.deletedSessionIds.push(sessionId);
    return true;
  }

  override getCurrentSessionId(): string {
    return this._currentSessionId;
  }

  override connectOpenRouter(apiKey: string): void {
    this.openRouterKey = apiKey;
    this.openRouterSessionActive = true;
    this.openAiCompatibleApiKey = undefined;
    this.openAiCompatibleSessionActive = false;
    this._config.modelProvider = "openai-compatible";
    this._config.openAiBaseUrl = "https://openrouter.ai/api/v1";
    this._config.openAiApiKey = apiKey;
  }

  override connectOpenAiCompatible(baseUrl: string, apiKey?: string): void {
    this.openAiCompatibleSessionActive = true;
    this.openRouterKey = undefined;
    this.openRouterSessionActive = false;
    this.openAiCompatibleApiKey = apiKey?.trim() || undefined;
    this._config.modelProvider = "openai-compatible";
    this._config.openAiBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (this.openAiCompatibleApiKey) {
      this._config.openAiApiKey = this.openAiCompatibleApiKey;
    } else {
      delete this._config.openAiApiKey;
    }
  }

  override disconnectOpenRouter(): boolean {
    if (!this.openRouterSessionActive) {
      return false;
    }

    this.openRouterSessionActive = false;
    this.openRouterKey = undefined;
    this._config.modelProvider = this._baseConfig.modelProvider;
    this._config.model = this._baseConfig.model;
    this._config.openAiBaseUrl = this._baseConfig.openAiBaseUrl;
    delete this._config.openAiApiKey;
    return true;
  }

  override isOpenRouterSessionConnected(): boolean {
    return this.openRouterSessionActive;
  }

  override disconnectOpenAiCompatible(): boolean {
    if (!this.openAiCompatibleSessionActive) {
      return false;
    }

    this.openAiCompatibleSessionActive = false;
    this.openAiCompatibleApiKey = undefined;
    this._config.modelProvider = this._baseConfig.modelProvider;
    this._config.model = this._baseConfig.model;
    this._config.openAiBaseUrl = this._baseConfig.openAiBaseUrl;
    delete this._config.openAiApiKey;
    return true;
  }

  override isOpenAiCompatibleSessionConnected(): boolean {
    return this.openAiCompatibleSessionActive;
  }

  override switchModel(modelId: string): void {
    this._config.model = modelId;
  }

  setBusy(busy: boolean): void {
    this._busy = busy;
  }

  override hasIndex(): boolean {
    return true;
  }

  override async refreshIndex(): Promise<boolean> {
    this.refreshIndexCount += 1;
    return true;
  }

  override getSymbols() {
    return [
      { name: "foo", qualifiedName: "foo", kind: "function", filePath: "src/foo.ts", startLine: 1, endLine: 5, signature: "function foo(): void", exported: true },
      { name: "Bar", qualifiedName: "Bar", kind: "class", filePath: "src/bar.ts", startLine: 1, endLine: 20, signature: "class Bar", exported: true },
      { name: "helper", qualifiedName: "Bar.helper", kind: "method", filePath: "src/bar.ts", startLine: 10, endLine: 15, signature: "helper(): string", exported: false },
    ];
  }

  override getSymbol(name: string): IndexedSymbol | undefined {
    const [match] = this.getSymbolMatches(name);
    if (!match) return undefined;
    return match;
  }

  override getSymbolMatches(name: string): IndexedSymbol[] {
    return this.getSymbols()
      .filter((s) => s.qualifiedName === name || s.name === name)
      .map((match) => ({
        ...match,
        dependencies: [],
        kind: match.kind as "function" | "class" | "method",
      }));
  }

  override getDependencies(symbolName: string) {
    if (symbolName === "foo") {
      return [
        { name: "foo", qualifiedName: "foo", kind: "function" as const, filePath: "src/foo.ts", signature: "function foo(): void" },
        { name: "Bar", qualifiedName: "Bar", kind: "class" as const, filePath: "src/bar.ts", signature: "class Bar" },
      ];
    }
    return undefined;
  }

  override getReferences(symbolName: string) {
    if (symbolName === "Bar") {
      return [{ from: "foo", kind: "calls" as const }];
    }
    return undefined;
  }

  override getCodeMap() {
    return { text: "## src/foo.ts\n- foo(): void", shownCount: 1, totalCount: 3 };
  }

  override getGraph() {
    return {
      nodes: [
        { id: "foo", name: "foo", kind: "function", filePath: "src/foo.ts", exported: true },
        { id: "Bar", name: "Bar", kind: "class", filePath: "src/bar.ts", exported: true },
      ],
      edges: [{ from: "foo", to: "Bar", kind: "calls" as const }],
    };
  }

  override getStructuralAnalysis(): StructuralAnalysisReport | undefined {
    return {
      version: 1,
      findings: [
        {
          id: "hotspot:foo",
          type: "hotspot",
          severity: "warning",
          title: "foo is a structural hotspot",
          summary: "foo has total degree 4.",
          symbols: ["foo"],
          files: ["src/foo.ts"],
          metrics: {
            totalDegree: 4,
            fanIn: 1,
            fanOut: 3,
            threshold: 4,
            score: 4,
          },
          rationale: ["Total degree exceeds the deterministic hotspot threshold."],
        },
      ],
      symbolMetrics: [
        {
          qualifiedName: "foo",
          name: "foo",
          kind: "function",
          filePath: "src/foo.ts",
          spanLines: 12,
          fanIn: 1,
          fanOut: 3,
          totalDegree: 4,
          inboundKinds: ["calls"],
          outboundKinds: ["calls"],
        },
      ],
      fileMetrics: [
        {
          filePath: "src/foo.ts",
          symbolCount: 1,
          incomingEdgeCount: 1,
          outgoingEdgeCount: 3,
          internalEdgeCount: 0,
          afferentCoupling: 1,
          efferentCoupling: 2,
          totalCoupling: 3,
          instability: 0.667,
        },
      ],
      summary: {
        symbolCount: 2,
        edgeCount: 1,
        fileCount: 2,
        findingCount: 1,
        cycleCount: 0,
        hotspotCount: 1,
        thresholds: {
          fanIn: 3,
          fanOut: 3,
          hotspot: 4,
          fileCoupling: 3,
        },
      },
    };
  }

  override getPinnedSymbols() {
    return [...this._pinned];
  }

  private _pinned = new Set<string>();

  override pinSymbol(name: string) {
    if (name === "nonexistent") return false;
    this._pinned.add(name);
    return true;
  }

  override unpinSymbol(name: string) {
    this._pinned.delete(name);
    return true;
  }

  // Annotation state for testing
  private _annotations = new Map<string, string[]>();

  override getAnnotations() {
    return Object.fromEntries(this._annotations);
  }

  override getAnnotationsForSymbol(name: string) {
    // Resolve symbol name to qualifiedName
    const sym = this.getSymbol(name);
    const key = sym ? (sym as unknown as { qualifiedName: string }).qualifiedName : name;
    return this._annotations.get(key) ?? [];
  }

  override addAnnotation(name: string, text: string) {
    const sym = this.getSymbol(name);
    if (!sym) return false;
    const trimmed = text.slice(0, 500).trim();
    if (trimmed.length === 0) return false;
    const key = (sym as unknown as { qualifiedName: string }).qualifiedName;
    const existing = this._annotations.get(key) ?? [];
    existing.push(trimmed);
    this._annotations.set(key, existing);
    return true;
  }

  override removeAnnotation(name: string, index: number) {
    const notes = this._annotations.get(name);
    if (!notes || index < 0 || index >= notes.length) return false;
    notes.splice(index, 1);
    if (notes.length === 0) this._annotations.delete(name);
    return true;
  }

  override clearAnnotations(name: string) {
    this._annotations.delete(name);
  }

  override async explainSymbol(
    name: string,
    onEvent: (event: UiUpdate) => void,
  ): Promise<string> {
    const sym = this.getSymbol(name);
    if (!sym) throw new Error(`Symbol "${name}" not found`);
    onEvent({ type: "streaming_chunk", content: `Explaining ${name}...` } as UiUpdate);
    return `Explaining ${name}...`;
  }

  override async explainStructuralFinding(
    findingId: string,
    onEvent: (event: UiUpdate) => void,
  ): Promise<string> {
    if (findingId !== "hotspot:foo") {
      throw new Error(`Structural finding "${findingId}" not found`);
    }
    onEvent({ type: "streaming_chunk", content: `Interpreting ${findingId}...` } as UiUpdate);
    return `Interpreting ${findingId}...`;
  }
}

class AmbiguousMockBridge extends MockBridge {
  override getSymbols() {
    return [
      ...super.getSymbols(),
      {
        name: "Review (type)",
        qualifiedName: "Review#type",
        kind: "type",
        filePath: "src/review.ts",
        startLine: 1,
        endLine: 1,
        signature: "type Review = { id: string }",
        exported: true,
      },
      {
        name: "Review (class)",
        qualifiedName: "Review#class",
        kind: "class",
        filePath: "src/review.ts",
        startLine: 3,
        endLine: 7,
        signature: "class Review",
        exported: true,
      },
    ];
  }

  override getSymbolMatches(name: string): IndexedSymbol[] {
    if (name === "Review") {
      return this.getSymbols()
        .filter((symbol) => symbol.qualifiedName.startsWith("Review#"))
        .map((match) => ({
          ...match,
          dependencies: [],
          kind: match.kind as IndexedSymbol["kind"],
        }));
    }

    return super.getSymbolMatches(name);
  }
}

class EmptySessionsBridge extends MockBridge {
  override async listSess() {
    return [];
  }

  override async saveSess(label?: string) {
    return {
      id: "sess-1",
      label: label ?? "auto-label",
      createdAt: "2026-01-01T00:00:00.000Z",
      savedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
    };
  }
}

class DuplicateSessionLabelBridge extends MockBridge {
  override async saveSess(): Promise<{
    id: string;
    label: string;
    createdAt: string;
    savedAt: string;
    messageCount: number;
  }> {
    throw new DuplicateSessionLabelError("test-session", "sess-1");
  }
}

// ── Test harness ──

let activeServer: Server | undefined;

function startTestServer(
  bridge: MockBridge,
  options: Parameters<typeof createRequestHandler>[2] = {},
): Promise<string> {
  const handler = createRequestHandler(bridge, undefined, options);
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

test("GET /api/config returns formatted config plus structured settings", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    config: string;
    restartRequired: boolean;
    secretsUiSupported: boolean;
    settings: {
      configPath: string;
      entries: Array<{ key: string; persistedValue: unknown }>;
    };
  };
  assert.ok(body.config.includes("workspaceRoot"));
  assert.ok(body.config.includes("test-model"));
  assert.equal(body.restartRequired, true);
  assert.equal(body.secretsUiSupported, false);
  assert.ok(body.settings.configPath.endsWith("/.minicode/.env"));
  assert.ok(body.settings.entries.some((entry) => entry.key === "maxSteps"));
});

test("GET /api/sessions returns session list", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    sessions: Array<{ id: string; label: string }>;
    currentSessionId: string;
  };
  assert.equal(body.sessions.length, 1);
  assert.equal(body.currentSessionId, "sess-1");
  assert.equal(body.sessions[0]!.id, "sess-1");
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

test("POST /api/sessions/save rejects duplicate session labels", async () => {
  const bridge = new DuplicateSessionLabelBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "test-session" }),
  });
  assert.equal(res.status, 409);

  const body = (await res.json()) as { error: string };
  assert.match(body.error, /already exists/);
});

test("session APIs support the first save when no sessions exist yet", async () => {
  const bridge = new EmptySessionsBridge();
  const base = await startTestServer(bridge);

  const listRes = await fetch(`${base}/api/sessions`);
  assert.equal(listRes.status, 200);
  const listBody = (await listRes.json()) as {
    sessions: Array<{ id: string; label: string }>;
    currentSessionId: string;
  };
  assert.equal(listBody.sessions.length, 0);
  assert.equal(listBody.currentSessionId, "sess-1");

  const saveRes = await fetch(`${base}/api/sessions/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(saveRes.status, 200);

  const saveBody = (await saveRes.json()) as { id: string; label: string };
  assert.equal(saveBody.id, "sess-1");
  assert.equal(saveBody.label, "auto-label");
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

  const body = (await res.json()) as {
    label: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.label, "test-session");
  assert.equal(body.messages.length, 10);
  assert.equal(body.messages[0]?.content, "message-2");
  assert.equal(body.messages[9]?.content, "message-11");
  assert.ok(
    body.messages.every((message) => !message.content.startsWith("[Conversation Summary")),
  );
});

test("DELETE /api/sessions/:id deletes a saved session", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/sess-1`, {
    method: "DELETE",
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { ok: boolean; deleted: boolean; id: string };
  assert.equal(body.ok, true);
  assert.equal(body.deleted, true);
  assert.equal(body.id, "sess-1");
  assert.deepEqual(bridge.deletedSessionIds, ["sess-1"]);
});

test("DELETE /api/sessions/:id returns 404 for unknown session", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/sessions/missing`, {
    method: "DELETE",
  });
  assert.equal(res.status, 404);

  const body = (await res.json()) as { error: string };
  assert.match(body.error, /Session not found/);
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

test("POST /api/openrouter/connect exchanges code and stores a session-only key", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://openrouter.ai/api/v1/auth/keys") {
      return originalFetch(input, init);
    }

    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)["Content-Type"], "application/json");
    const body = JSON.parse(String(init?.body)) as {
      code: string;
      code_verifier: string;
      code_challenge_method: string;
    };
    assert.equal(body.code, "oauth-code");
    assert.equal(body.code_verifier, "pkce-verifier");
    assert.equal(body.code_challenge_method, "S256");
    return new Response(
      JSON.stringify({ key: "sk-or-v1-session-key" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const res = await originalFetch(`${base}/api/openrouter/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", codeVerifier: "pkce-verifier" }),
    });
    assert.equal(res.status, 200);

    const body = await res.json() as {
      ok: boolean;
      sessionOnly: boolean;
      persistedToEnv: boolean;
      persistedEnvPath: string | null;
      persistWarning: string | null;
      baseUrl: string;
      needsSetup: boolean;
      missing: string[];
      message: string;
    };
    assert.equal(body.ok, true);
    assert.equal(body.sessionOnly, true);
    assert.equal(body.persistedToEnv, false);
    assert.equal(body.persistedEnvPath, null);
    assert.equal(body.persistWarning, null);
    assert.equal(body.baseUrl, "https://openrouter.ai/api/v1");
    assert.equal(body.needsSetup, false);
    assert.deepEqual(body.missing, []);
    assert.equal(body.message, "OpenRouter connected for this serve session.");
    assert.equal(bridge.openRouterKey, "sk-or-v1-session-key");
    assert.equal(bridge.getConfig().modelProvider, "openai-compatible");
    assert.equal(bridge.getConfig().openAiBaseUrl, "https://openrouter.ai/api/v1");
    assert.equal(bridge.getConfig().openAiApiKey, "sk-or-v1-session-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/openrouter/connect can persist OpenRouter setup to ~/.minicode/.env", async () => {
  const bridge = new MockBridge();
  const minicodeHome = mkdtempSync(path.join(os.tmpdir(), "minicode-openrouter-home-"));
  const base = await startTestServer(bridge, { minicodeHome });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://openrouter.ai/api/v1/auth/keys") {
      return originalFetch(input, init);
    }

    return new Response(
      JSON.stringify({ key: "sk-or-v1-session-key" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const res = await originalFetch(`${base}/api/openrouter/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "oauth-code", codeVerifier: "pkce-verifier", persistToEnv: true }),
    });
    assert.equal(res.status, 200);

    const body = await res.json() as {
      persistedToEnv: boolean;
      persistedEnvPath: string | null;
      persistWarning: string | null;
      message: string;
    };
    assert.equal(body.persistedToEnv, true);
    assert.equal(body.persistWarning, null);
    assert.equal(body.persistedEnvPath, path.join(minicodeHome, ".env"));
    assert.match(body.message, /saved to ~\/\.minicode\/\.env/);

    const envContents = readFileSync(path.join(minicodeHome, ".env"), "utf8");
    assert.match(envContents, /^MODEL_PROVIDER=openai-compatible$/m);
    assert.match(envContents, /^OPENAI_BASE_URL=https:\/\/openrouter\.ai\/api\/v1$/m);
    assert.match(envContents, /^OPENROUTER_API_KEY=sk-or-v1-session-key$/m);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(minicodeHome, { recursive: true, force: true });
  }
});

test("POST /api/model persists the selected model to ~/.minicode/.env", async () => {
  const bridge = new MockBridge();
  const minicodeHome = mkdtempSync(path.join(os.tmpdir(), "minicode-model-home-"));
  const envPath = path.join(minicodeHome, ".env");
  writeFileSync(
    envPath,
    [
      "MODEL_PROVIDER=openai-compatible",
      "OPENAI_BASE_URL=https://openrouter.ai/api/v1",
      "OPENROUTER_API_KEY=sk-or-v1-session-key",
      "",
    ].join("\n"),
    "utf8",
  );
  const base = await startTestServer(bridge, { minicodeHome });

  try {
    const res = await fetch(`${base}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/test-model" }),
    });
    assert.equal(res.status, 200);

    const body = await res.json() as {
      model: string;
      persistedToEnv: boolean;
      persistedEnvPath: string | null;
    };
    assert.equal(body.model, "openrouter/test-model");
    assert.equal(body.persistedToEnv, true);
    assert.equal(body.persistedEnvPath, envPath);

    const envContents = readFileSync(envPath, "utf8");
    assert.match(envContents, /^MODEL=openrouter\/test-model$/m);
    assert.match(envContents, /^OPENROUTER_API_KEY=sk-or-v1-session-key$/m);
    assert.equal(bridge.getConfig().model, "openrouter/test-model");
  } finally {
    rmSync(minicodeHome, { recursive: true, force: true });
  }
});

test("POST /api/openrouter/disconnect removes the session-only OpenRouter connection", async () => {
  const bridge = new MockBridge();
  bridge.connectOpenRouter("sk-or-v1-session-key");
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/openrouter/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200);

  const body = await res.json() as {
    ok: boolean;
    disconnected: boolean;
    sessionOnly: boolean;
    baseUrl: string;
    provider: string;
    message: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.disconnected, true);
  assert.equal(body.sessionOnly, true);
  assert.equal(body.provider, "anthropic");
  assert.equal(body.baseUrl, "http://localhost:1234/v1");
  assert.equal(
    body.message,
    "Removed the session-only OpenRouter connection and restored your original provider settings.",
  );
  assert.equal(bridge.openRouterSessionActive, false);
  assert.equal(bridge.getConfig().modelProvider, "anthropic");
  assert.equal(bridge.getConfig().openAiBaseUrl, "http://localhost:1234/v1");
  assert.equal(bridge.getConfig().openAiApiKey, undefined);
});

test("GET /api/status exposes OpenRouter session state and base URL", async () => {
  const bridge = new MockBridge();
  bridge.connectOpenRouter("sk-or-v1-session-key");
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);

  const body = await res.json() as {
    baseUrl: string;
    sessionOpenRouterConnected: boolean;
    provider: string;
  };
  assert.equal(body.provider, "openai-compatible");
  assert.equal(body.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(body.sessionOpenRouterConnected, true);
});

test("POST /api/openai-compatible/connect stores a session-only endpoint", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/openai-compatible/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "http://localhost:1234/v1/", apiKey: "local-key" }),
  });
  assert.equal(res.status, 200);

  const body = await res.json() as {
    ok: boolean;
    sessionOnly: boolean;
    persistedToEnv: boolean;
    persistedEnvPath: string | null;
    persistWarning: string | null;
    baseUrl: string;
    needsSetup: boolean;
    missing: string[];
    message: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.sessionOnly, true);
  assert.equal(body.persistedToEnv, false);
  assert.equal(body.persistedEnvPath, null);
  assert.equal(body.persistWarning, null);
  assert.equal(body.baseUrl, "http://localhost:1234/v1");
  assert.equal(body.needsSetup, false);
  assert.deepEqual(body.missing, []);
  assert.equal(body.message, "The OpenAI-compatible provider connected for this serve session.");
  assert.equal(bridge.getConfig().modelProvider, "openai-compatible");
  assert.equal(bridge.getConfig().openAiBaseUrl, "http://localhost:1234/v1");
  assert.equal(bridge.getConfig().openAiApiKey, "local-key");
  assert.equal(bridge.isOpenAiCompatibleSessionConnected(), true);
});

test("POST /api/openai-compatible/connect can persist the endpoint to ~/.minicode/.env", async () => {
  const bridge = new MockBridge();
  const minicodeHome = mkdtempSync(path.join(os.tmpdir(), "minicode-openai-compatible-home-"));
  const base = await startTestServer(bridge, { minicodeHome });

  try {
    const res = await fetch(`${base}/api/openai-compatible/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "",
        persistToEnv: true,
      }),
    });
    assert.equal(res.status, 200);

    const body = await res.json() as {
      persistedToEnv: boolean;
      persistedEnvPath: string | null;
      persistWarning: string | null;
      message: string;
    };
    assert.equal(body.persistedToEnv, true);
    assert.equal(body.persistWarning, null);
    assert.equal(body.persistedEnvPath, path.join(minicodeHome, ".env"));
    assert.match(body.message, /saved to ~\/\.minicode\/\.env/);

    const envContents = readFileSync(path.join(minicodeHome, ".env"), "utf8");
    assert.match(envContents, /^MODEL_PROVIDER=openai-compatible$/m);
    assert.match(envContents, /^OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:1234\/v1$/m);
    assert.doesNotMatch(envContents, /^OPENAI_API_KEY=/m);
  } finally {
    rmSync(minicodeHome, { recursive: true, force: true });
  }
});

test("POST /api/openai-compatible/disconnect removes the session-only endpoint", async () => {
  const bridge = new MockBridge();
  bridge.connectOpenAiCompatible("http://localhost:1234/v1", "local-key");
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/openai-compatible/disconnect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200);

  const body = await res.json() as {
    ok: boolean;
    disconnected: boolean;
    sessionOnly: boolean;
    baseUrl: string;
    provider: string;
    message: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.disconnected, true);
  assert.equal(body.sessionOnly, true);
  assert.equal(body.provider, "anthropic");
  assert.equal(body.baseUrl, "http://localhost:1234/v1");
  assert.equal(
    body.message,
    "Removed the session-only OpenAI-compatible connection and restored your original provider settings.",
  );
  assert.equal(bridge.isOpenAiCompatibleSessionConnected(), false);
  assert.equal(bridge.getConfig().modelProvider, "anthropic");
  assert.equal(bridge.getConfig().openAiApiKey, undefined);
});

test("GET /api/status exposes OpenAI-compatible session state and base URL", async () => {
  const bridge = new MockBridge();
  bridge.connectOpenAiCompatible("http://localhost:1234/v1");
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 200);

  const body = await res.json() as {
    baseUrl: string;
    sessionOpenAiCompatibleConnected: boolean;
    provider: string;
  };
  assert.equal(body.provider, "openai-compatible");
  assert.equal(body.baseUrl, "http://localhost:1234/v1");
  assert.equal(body.sessionOpenAiCompatibleConnected, true);
});

test("POST /api/openrouter/connect returns 400 when code is missing", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/openrouter/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codeVerifier: "pkce-verifier" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/openrouter/connect surfaces exchange failures", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    if (String(input) !== "https://openrouter.ai/api/v1/auth/keys") {
      return originalFetch(input, init);
    }
    return new Response("Invalid code", { status: 403 });
  };

  try {
    const res = await originalFetch(`${base}/api/openrouter/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad-code", codeVerifier: "pkce-verifier" }),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes("OpenRouter OAuth exchange failed"));
    assert.ok(body.error.includes("Invalid code"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /api/openai-compatible/connect rejects an invalid endpoint", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/openai-compatible/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "localhost:1234/v1" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /valid absolute http\(s\) URL/);
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
  assert.equal(res.headers.get("cache-control"), "no-store");

  const html = await res.text();
  assert.ok(html.includes("minicode"));
});

test("GET /style.css serves CSS file", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/style.css`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/css");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("GET /app.js serves JS file", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/app.js`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/javascript");
  assert.equal(res.headers.get("cache-control"), "no-store");
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

// ── Graph / Index API tests ──

test("GET /api/symbols returns all symbols", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { symbols: Array<{ name: string; kind: string }> };
  assert.equal(body.symbols.length, 3);
  assert.equal(body.symbols[0]!.name, "foo");
  assert.equal(body.symbols[1]!.name, "Bar");
  assert.equal(body.symbols[2]!.name, "helper");
});

test("GET /api/symbols/:name/dependencies returns dependency cone", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/foo/dependencies`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { symbol: string; dependencies: Array<{ name: string }> };
  assert.equal(body.symbol, "foo");
  assert.equal(body.dependencies.length, 2);
});

test("GET /api/symbols/:name/dependencies returns 404 for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/nonexistent/dependencies`);
  assert.equal(res.status, 404);
});

test("GET /api/symbols/:name/dependencies returns 409 for ambiguous symbol", async () => {
  const bridge = new AmbiguousMockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/Review/dependencies`);
  assert.equal(res.status, 409);

  const body = (await res.json()) as {
    error: string;
    candidates: Array<{ qualifiedName: string }>;
  };
  assert.equal(body.error, 'Symbol "Review" is ambiguous');
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.qualifiedName).sort(),
    ["Review#class", "Review#type"],
  );
});

test("GET /api/symbols/:name/references returns references", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/Bar/references`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { symbol: string; references: Array<{ from: string; kind: string }> };
  assert.equal(body.symbol, "Bar");
  assert.equal(body.references.length, 1);
  assert.equal(body.references[0]!.from, "foo");
});

test("GET /api/symbols/:name/references returns 404 for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/nonexistent/references`);
  assert.equal(res.status, 404);
});

test("GET /api/symbols/:name/references returns 409 for ambiguous symbol", async () => {
  const bridge = new AmbiguousMockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/Review/references`);
  assert.equal(res.status, 409);

  const body = (await res.json()) as {
    error: string;
    candidates: Array<{ qualifiedName: string }>;
  };
  assert.equal(body.error, 'Symbol "Review" is ambiguous');
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.qualifiedName).sort(),
    ["Review#class", "Review#type"],
  );
});

test("GET /api/code-map returns code map", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/code-map`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { text: string; shownCount: number; totalCount: number };
  assert.ok(body.text.includes("foo"));
  assert.equal(body.shownCount, 1);
  assert.equal(body.totalCount, 3);
});

test("GET /api/graph returns nodes and edges", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/graph`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  };
  assert.equal(body.nodes.length, 2);
  assert.equal(body.edges.length, 1);
  assert.equal(body.edges[0]!.from, "foo");
  assert.equal(body.edges[0]!.to, "Bar");
  assert.equal(body.edges[0]!.kind, "calls");
});

test("POST /api/index/refresh rebuilds the project index", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/index/refresh`, { method: "POST" });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { ok: boolean; symbolCount: number; edgeCount: number };
  assert.equal(body.ok, true);
  assert.equal(body.symbolCount, 2);
  assert.equal(body.edgeCount, 1);
  assert.equal(bridge.refreshIndexCount, 1);
});

test("GET /api/analysis returns deterministic structural findings", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/analysis`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    version: number;
    findings: Array<{ type: string; symbols: string[] }>;
    summary: { hotspotCount: number; findingCount: number };
  };

  assert.equal(body.version, 1);
  assert.equal(body.summary.hotspotCount, 1);
  assert.equal(body.summary.findingCount, 1);
  assert.equal(body.findings[0]?.type, "hotspot");
  assert.deepEqual(body.findings[0]?.symbols, ["foo"]);
});

test("POST /api/analysis/explain returns SSE stream", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/analysis/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ findingId: "hotspot:foo" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const text = await res.text();
  assert.ok(text.includes("Interpreting hotspot:foo"));
  assert.ok(text.includes("[DONE]"));
});

test("POST /api/analysis/explain rejects missing finding id", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/analysis/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "findingId is required" });
});

test("POST /api/analysis/explain streams error event for unknown finding", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/analysis/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ findingId: "missing" }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  const errorLine = text.split("\n").find((line) => line.startsWith("data: {") && line.includes('"type":"error"'));
  assert.ok(errorLine);
  const payload = JSON.parse(errorLine!.slice(6)) as { type: string; message: string };
  assert.equal(payload.type, "error");
  assert.equal(payload.message, 'Structural finding "missing" not found');
});

test("GET /api/focus returns pinned symbols", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/focus`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { pinned: string[] };
  assert.deepEqual(body.pinned, []);
});

test("POST /api/focus pins and unpins symbols", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Pin
  const pinRes = await fetch(`${base}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pin", symbol: "foo" }),
  });
  assert.equal(pinRes.status, 200);
  const pinBody = (await pinRes.json()) as { pinned: string[] };
  assert.ok(pinBody.pinned.includes("foo"));

  // Unpin
  const unpinRes = await fetch(`${base}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "unpin", symbol: "foo" }),
  });
  assert.equal(unpinRes.status, 200);
  const unpinBody = (await unpinRes.json()) as { pinned: string[] };
  assert.ok(!unpinBody.pinned.includes("foo"));
});

test("POST /api/focus returns 404 for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "pin", symbol: "nonexistent" }),
  });
  assert.equal(res.status, 404);
});

test("POST /api/focus returns 400 for invalid action", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/focus`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "toggle", symbol: "foo" }),
  });
  assert.equal(res.status, 400);
});

// ── Symbol source endpoint tests ──

test("GET /api/symbols/:name/source returns source code for known symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Create a temp file matching the mock symbol's filePath
  const wsRoot = "/tmp/test-workspace";
  mkdirSync(`${wsRoot}/src`, { recursive: true });
  writeFileSync(`${wsRoot}/src/foo.ts`, "line1\nfunction foo(): void {\n  return;\n}\nline5\n");

  try {
    const res = await fetch(`${base}/api/symbols/foo/source`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { symbol: string; filePath: string; startLine: number; endLine: number; source: string };
    assert.equal(body.symbol, "foo");
    assert.equal(body.filePath, "src/foo.ts");
    assert.equal(body.startLine, 1);
    assert.equal(body.endLine, 5);
    assert.ok(body.source.includes("line1"));
  } finally {
    rmSync(wsRoot, { recursive: true, force: true });
  }
});

test("GET /api/symbols/:name/source returns 404 for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/nonexistent/source`);
  assert.equal(res.status, 404);

  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("nonexistent"));
});

test("GET /api/symbols/:name/source returns 409 for ambiguous symbol", async () => {
  const bridge = new AmbiguousMockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/Review/source`);
  assert.equal(res.status, 409);

  const body = (await res.json()) as {
    error: string;
    candidates: Array<{ qualifiedName: string }>;
  };
  assert.equal(body.error, 'Symbol "Review" is ambiguous');
  assert.deepEqual(
    body.candidates.map((candidate) => candidate.qualifiedName).sort(),
    ["Review#class", "Review#type"],
  );
});

test("GET /api/symbols/:name/source returns 500 when file is missing", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Don't create the file — let it fail with a read error
  const res = await fetch(`${base}/api/symbols/foo/source`);
  assert.equal(res.status, 500);

  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("src/foo.ts"));
});

test("GET /api/file-source returns full file contents for a workspace file", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const wsRoot = "/tmp/test-workspace";
  mkdirSync(`${wsRoot}/src`, { recursive: true });
  writeFileSync(`${wsRoot}/src/foo.ts`, "line1\nfunction foo(): void {\n  return;\n}\nline5\n");

  try {
    const res = await fetch(`${base}/api/file-source?path=${encodeURIComponent("src/foo.ts")}`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { filePath: string; source: string };
    assert.equal(body.filePath, "src/foo.ts");
    assert.ok(body.source.includes("function foo(): void"));
    assert.ok(body.source.includes("line5"));
  } finally {
    rmSync(wsRoot, { recursive: true, force: true });
  }
});

test("GET /api/file-source rejects path traversal", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/file-source?path=${encodeURIComponent("../secret.txt")}`);
  assert.equal(res.status, 403);

  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("Invalid workspace file path"));
});

// ── Annotations API tests ──

test("GET /api/annotations returns empty annotations initially", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/annotations`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { annotations: Record<string, string[]> };
  assert.deepEqual(body.annotations, {});
});

test("POST /api/symbols/:name/annotations adds annotation", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "don't modify, stable API" }),
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { symbol: string; annotations: string[] };
  assert.equal(body.symbol, "foo");
  assert.equal(body.annotations.length, 1);
  assert.equal(body.annotations[0], "don't modify, stable API");
});

test("GET /api/symbols/:name/annotations returns annotations for symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Add one first
  await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "note 1" }),
  });

  const res = await fetch(`${base}/api/symbols/foo/annotations`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { symbol: string; annotations: string[] };
  assert.equal(body.annotations.length, 1);
  assert.equal(body.annotations[0], "note 1");
});

test("POST /api/symbols/:name/annotations returns 404 for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/nonexistent/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hello" }),
  });
  assert.equal(res.status, 404);
});

test("POST /api/symbols/:name/annotations returns 400 for missing text", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test("DELETE /api/symbols/:name/annotations/:index removes annotation", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Add two annotations
  await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "first" }),
  });
  await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "second" }),
  });

  // Remove first
  const res = await fetch(`${base}/api/symbols/foo/annotations/0`, {
    method: "DELETE",
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { annotations: string[] };
  assert.equal(body.annotations.length, 1);
  assert.equal(body.annotations[0], "second");
});

test("DELETE /api/symbols/:name/annotations/:index returns 404 for invalid index", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/foo/annotations/99`, {
    method: "DELETE",
  });
  assert.equal(res.status, 404);
});

test("DELETE /api/symbols/:name/annotations clears all annotations", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  // Add annotations
  await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "note" }),
  });

  // Clear all
  const res = await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "DELETE",
  });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { annotations: string[] };
  assert.deepEqual(body.annotations, []);
});

test("GET /api/annotations returns all annotations after adding", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  await fetch(`${base}/api/symbols/foo/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "foo note" }),
  });
  await fetch(`${base}/api/symbols/Bar/annotations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "bar note" }),
  });

  const res = await fetch(`${base}/api/annotations`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as { annotations: Record<string, string[]> };
  assert.ok(Object.keys(body.annotations).length >= 2);
});

test("GET /api/symbols/:name/explain returns SSE stream", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/foo/explain`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");

  const text = await res.text();
  assert.ok(text.includes("data: "));
  assert.ok(text.includes("[DONE]"));
});

test("GET /api/symbols/:name/explain returns error for unknown symbol", async () => {
  const bridge = new MockBridge();
  const base = await startTestServer(bridge);

  const res = await fetch(`${base}/api/symbols/nonexistent/explain`);
  assert.equal(res.status, 200); // SSE always starts 200
  const text = await res.text();
  assert.ok(text.includes("error"));
});

// ── Graceful shutdown tests ──

test("shutdownServe terminates WebSocket clients and calls exit(0)", async () => {
  const bridge = new MockBridge();
  const handler = createRequestHandler(bridge);
  const server = createServer(handler);

  const { WebSocketServer, WebSocket } = await import("ws");
  const wss = new WebSocketServer({ server });

  const openSockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  // Start server on random port
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as import("node:net").AddressInfo;

  // Connect a WebSocket client (simulates browser tab)
  const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
  await new Promise<void>((resolve) => ws.on("open", resolve));

  assert.ok(wss.clients.size >= 1, "Should have at least 1 WS client connected");
  assert.ok(openSockets.size >= 1, "Should have at least 1 open socket");

  // Call shutdownServe with a mock exit function
  let exitCode: number | undefined;
  shutdownServe(server, wss, openSockets, (code) => {
    exitCode = code;
  });

  // Wait a tick for async cleanup to propagate
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(exitCode, 0, "Should have called exit with code 0");
  assert.equal(openSockets.size, 0, "All sockets should be cleared");
  assert.equal(wss.clients.size, 0, "All WS clients should be removed");
});

test("shutdownServe works when no clients are connected", async () => {
  const bridge = new MockBridge();
  const handler = createRequestHandler(bridge);
  const server = createServer(handler);

  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ server });
  const openSockets = new Set<import("node:net").Socket>();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  let exitCode: number | undefined;
  shutdownServe(server, wss, openSockets, (code) => {
    exitCode = code;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(exitCode, 0, "Should exit cleanly with no clients");
});

test("shutdownServe terminates multiple WebSocket clients", async () => {
  const bridge = new MockBridge();
  const handler = createRequestHandler(bridge);
  const server = createServer(handler);

  const { WebSocketServer, WebSocket } = await import("ws");
  const wss = new WebSocketServer({ server });

  const openSockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as import("node:net").AddressInfo;

  // Connect 3 WebSocket clients
  const clients: InstanceType<typeof WebSocket>[] = [];
  for (let i = 0; i < 3; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${addr.port}`);
    await new Promise<void>((resolve) => ws.on("open", resolve));
    clients.push(ws);
  }

  assert.equal(wss.clients.size, 3, "Should have 3 WS clients connected");

  let exitCode: number | undefined;
  shutdownServe(server, wss, openSockets, (code) => {
    exitCode = code;
  });

  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(exitCode, 0, "Should have called exit with code 0");
  assert.equal(openSockets.size, 0, "All sockets should be cleared");
});
