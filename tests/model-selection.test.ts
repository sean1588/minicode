import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { OpenAICompatibleModelClient } from "@minicode/agent-sdk";
import type { ModelInfo } from "@minicode/agent-sdk";
import { createRequestHandler } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import { createTestAgentConfig } from "./test-utils.js";

// ── OpenAI-compatible listModels ──

test("openai-compatible listModels fetches /models and parses response", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    assert.ok(String(input).endsWith("/models"));
    return new Response(
      JSON.stringify({
        data: [
          { id: "model-a", name: "Model A" },
          { id: "model-b" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const models = await client.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0]!.id, "model-a");
  assert.equal(models[0]!.name, "Model A");
  assert.equal(models[1]!.id, "model-b");
  assert.equal(models[1]!.name, "model-b"); // falls back to id
});

test("openai-compatible listModels returns empty array on error", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response("Server error", { status: 500 });
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const models = await client.listModels();
  assert.deepEqual(models, []);
});

test("openai-compatible listModels returns empty array on network failure", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("Connection refused");
  };

  const client = new OpenAICompatibleModelClient({
    baseUrl: "http://localhost:1234/v1",
    fetchImpl,
  });

  const models = await client.listModels();
  assert.deepEqual(models, []);
});

// ── Serve API /api/models and /api/model ──

class MockBridgeForModels extends AgentBridge {
  constructor() {
    super(() => {}, false);
  }

  override isBusy(): boolean {
    return false;
  }

  override getConfig() {
    return createTestAgentConfig("/tmp/test-workspace");
  }

  override async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "model-x", name: "Model X" },
      { id: "model-y", name: "Model Y" },
    ];
  }

  override switchModel(modelId: string): void {
    (this.getConfig() as { model: string }).model = modelId;
  }

  override async runTurn(message: string) {
    return { text: `Echo: ${message}`, usage: { inputTokens: 1, outputTokens: 1 } };
  }

  override async listSess() { return []; }
  override hasIndex() { return false; }
}

function startTestServer(bridge: AgentBridge): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const handler = createRequestHandler(bridge);
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()!;
      const port = typeof addr === "string" ? 0 : addr.port;
      resolve({ server, port });
    });
  });
}

test("GET /api/models returns model list and active model", async () => {
  const bridge = new MockBridgeForModels();
  const { server, port } = await startTestServer(bridge);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/models`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as { models: ModelInfo[]; activeModel: string };
    assert.equal(data.models.length, 2);
    assert.equal(data.models[0]!.id, "model-x");
    assert.equal(data.activeModel, "test-model");
  } finally {
    server.close();
  }
});

test("POST /api/model switches the active model", async () => {
  const bridge = new MockBridgeForModels();
  const { server, port } = await startTestServer(bridge);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-y" }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { model: string };
    assert.equal(data.model, "model-y");
  } finally {
    server.close();
  }
});

test("POST /api/model returns 400 when model is missing", async () => {
  const bridge = new MockBridgeForModels();
  const { server, port } = await startTestServer(bridge);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
