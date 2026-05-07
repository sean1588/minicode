import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import type { ModelInfo } from "@sean.holung/minicode-sdk";
import { createRequestHandler } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import { createTestAgentConfig } from "./test-utils.js";

class ConfigApiBridge extends AgentBridge {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    super(() => {}, false);
    this.workspaceRoot = workspaceRoot;
  }

  override isBusy(): boolean {
    return false;
  }

  override getConfig() {
    return createTestAgentConfig(this.workspaceRoot);
  }

  override async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  override async runTurn(message: string) {
    return { text: `Echo: ${message}`, usage: { inputTokens: 1, outputTokens: 1 } };
  }

  override async listSess() { return []; }
  override hasIndex() { return false; }
}

const activeServers = new Set<Server>();
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    [...activeServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  activeServers.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer(
  bridge: AgentBridge,
  options: { minicodeHome?: string } = {},
): Promise<string> {
  const server = createServer(createRequestHandler(bridge, undefined, options));
  activeServers.add(server);

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(`http://127.0.0.1:${address.port}`);
      }
    });
  });
}

async function withUnsetEnvVars(
  names: string[],
  callback: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    delete process.env[name];
  }

  try {
    await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("GET /api/config returns structured editable settings payload", async () => {
  await withUnsetEnvVars(["MAX_STEPS"], async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-config-api-"));
    const minicodeHome = await mkdtemp(path.join(os.tmpdir(), "minicode-config-home-"));
    tempDirs.push(workspaceRoot);
    tempDirs.push(minicodeHome);
    const base = await startServer(new ConfigApiBridge(workspaceRoot), { minicodeHome });

    const res = await fetch(`${base}/api/config`);
    assert.equal(res.status, 200);

    const body = await res.json() as {
      config: string;
      settings: {
        configPath: string;
        entries: Array<{
          key: string;
          type: string;
          description: string;
          envVar: string;
          effectiveValue: unknown;
          persistedValue: unknown;
          envValue: unknown;
          overriddenByEnv: boolean;
        }>;
      };
      restartRequired: boolean;
      secretsUiSupported: boolean;
    };

    assert.match(body.config, /workspaceRoot/);
    assert.equal(body.restartRequired, true);
    assert.equal(body.secretsUiSupported, false);
    assert.equal(body.settings.configPath, path.join(minicodeHome, ".env"));
    const maxSteps = body.settings.entries.find((entry) => entry.key === "maxSteps");
    assert.equal(maxSteps?.type, "number");
    assert.equal(maxSteps?.envVar, "MAX_STEPS");
    assert.equal(maxSteps?.effectiveValue, 10);
    assert.equal(maxSteps?.persistedValue, null);
    assert.equal(maxSteps?.envValue, null);
    assert.equal(maxSteps?.overriddenByEnv, false);
    assert.match(maxSteps?.description ?? "", /Turn call limit/);

    const modelTimeout = body.settings.entries.find((entry) => entry.key === "modelTimeoutSeconds");
    assert.equal(modelTimeout?.type, "number");
    assert.equal(modelTimeout?.envVar, "MODEL_TIMEOUT_SECONDS");
    assert.equal(modelTimeout?.effectiveValue, 60);
    assert.match(modelTimeout?.description ?? "", /start responding/);
  });
});

test("POST /api/config persists global settings and returns updated metadata", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-config-api-"));
  const minicodeHome = await mkdtemp(path.join(os.tmpdir(), "minicode-config-home-"));
  tempDirs.push(workspaceRoot);
  tempDirs.push(minicodeHome);
  const base = await startServer(new ConfigApiBridge(workspaceRoot), { minicodeHome });

  const res = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      updates: {
        maxSteps: 42,
        enableDynamicPrompt: false,
      },
    }),
  });
  assert.equal(res.status, 200);

  const body = await res.json() as {
    ok: boolean;
    scope: string;
    path: string;
    saved: Array<{ key: string; value: unknown }>;
    restartRequired: boolean;
    message: string;
    settings: {
      entries: Array<{ key: string; persistedValue: unknown }>;
    };
  };

  assert.equal(body.ok, true);
  assert.equal(body.scope, "global");
  assert.equal(body.path, path.join(minicodeHome, ".env"));
  assert.equal(body.restartRequired, true);
  assert.match(body.message, /Persisted config updated/);
  assert.deepEqual(body.saved, [
    { key: "maxSteps", value: 42 },
    { key: "enableDynamicPrompt", value: false },
  ]);

  const persisted = await readFile(path.join(minicodeHome, ".env"), "utf8");
  assert.match(persisted, /^MAX_STEPS=42$/m);
  assert.match(persisted, /^ENABLE_DYNAMIC_PROMPT=false$/m);

  const maxSteps = body.settings.entries.find((entry) => entry.key === "maxSteps");
  assert.equal(maxSteps?.persistedValue, 42);
});


test("POST /api/config rejects invalid keys", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-config-api-"));
  tempDirs.push(workspaceRoot);
  const base = await startServer(new ConfigApiBridge(workspaceRoot));

  const res = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      updates: {
        openAiApiKey: "secret",
      },
    }),
  });

  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /Unknown editable config key/);
});
