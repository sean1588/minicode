/**
 * Integration tests for the config system.
 *
 * Tests the current config resolution chain: ~/.minicode/.env → shell env vars,
 * getConfigSetupMessage / getConfigMissing, minicode home bootstrapping, the /api/status needsSetup flag,
 * and AgentBridge graceful degradation when model client cannot initialize.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  loadAgentConfig,
  resolveConfigEnv,
  getConfigSetupMessage,
  getConfiguredProvider,
  getConfigMissing,
} from "../src/agent/config.js";
import { buildStructuredConfigPayload } from "../src/agent/editable-config.js";
import { createRequestHandler } from "../src/serve/server.js";
import { AgentBridge } from "../src/serve/agent-bridge.js";
import { createTestAgentConfig } from "./test-utils.js";

// ── Helpers ──

const tempDirs: string[] = [];
const activeServers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...activeServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  activeServers.clear();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** Create an isolated minicode home directory with optional config and .env files. */
function serializeConfigEnv(config: Record<string, unknown>): string {
  const lines: string[] = [];
  const push = (key: string, value: unknown) => {
    if (value === undefined || value === null) {
      return;
    }
    lines.push(`${key}=${String(value)}`);
  };

  push("MODEL_PROVIDER", config.modelProvider);
  push("MODEL", config.model);
  push("MAX_STEPS", config.maxSteps);
  push("MAX_TOKENS", config.maxTokens);
  push("MAX_CONTEXT_TOKENS", config.maxContextTokens);
  push("WORKSPACE_ROOT", config.workspaceRoot);
  push("COMMAND_TIMEOUT_MS", config.commandTimeout);
  if (Array.isArray(config.commandDenylist)) {
    lines.push(`COMMAND_DENYLIST=${JSON.stringify(config.commandDenylist)}`);
  }
  push("CONFIRM_DESTRUCTIVE", config.confirmDestructive);
  push("MAX_FILE_SIZE_BYTES", config.maxFileSizeBytes);
  push("KEEP_RECENT_MESSAGES", config.keepRecentMessages);
  push("LOOP_DETECTION_WINDOW", config.loopDetectionWindow);
  push("MAX_TOOL_OUTPUT_CHARS", config.maxToolOutputChars);
  push("OPENAI_BASE_URL", config.openAiBaseUrl);
  push("OPENAI_API_KEY", config.openAiApiKey);
  push("ENABLE_FILE_READ_DEDUP", config.enableFileReadDedup);
  push("ENABLE_ADAPTIVE_KEEP_RECENT", config.enableAdaptiveKeepRecent);
  push("ENABLE_TOOL_OUTPUT_TRUNCATION", config.enableToolOutputTruncation);
  push("COMPACTION_THRESHOLD", config.compactionThreshold);
  push("COMPACTION_MODEL", config.compactionModel);
  push("REASONING_EFFORT", config.reasoningEffort);
  push("ENABLE_DYNAMIC_PROMPT", config.enableDynamicPrompt);

  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

async function createTestHome(options: {
  config?: Record<string, unknown>;
  dotenv?: string;
} = {}): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-integ-"));
  tempDirs.push(home);
  const envContent = `${options.config ? serializeConfigEnv(options.config) : ""}${options.dotenv ?? ""}`;
  if (envContent.length > 0) {
    await writeFile(path.join(home, ".env"), envContent, "utf8");
  }
  return home;
}

/**
 * Temporarily set process.env vars, run a callback, then restore originals.
 * Keys mapped to `undefined` are deleted.
 */
async function withEnv(
  overrides: Record<string, string | undefined>,
  callback: () => Promise<void>,
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** A bridge whose getConfig returns a custom config object for testing needsSetup. */
class ConfigurableBridge extends AgentBridge {
  private readonly _config: ReturnType<AgentBridge["getConfig"]>;
  private readonly _ready: boolean;

  constructor(config: ReturnType<AgentBridge["getConfig"]>, ready = true) {
    super(() => {}, false);
    this._config = config;
    this._ready = ready;
  }

  override isReady(): boolean {
    return this._ready;
  }
  override isBusy(): boolean {
    return false;
  }
  override getConfig() {
    return this._config;
  }
  override async runTurn(message: string) {
    return { text: `Echo: ${message}`, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  override async listSess() { return []; }
  override hasIndex() { return false; }
}

function startServer(
  bridge: AgentBridge,
  options: { minicodeHome?: string } = {},
): Promise<string> {
  const server = createServer(createRequestHandler(bridge, undefined, options));
  activeServers.add(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve(`http://127.0.0.1:${addr.port}`);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// Home env loading via loadAgentConfig
// ═══════════════════════════════════════════════════════════════════

describe("loadAgentConfig home env", () => {
  test("uses ~/.minicode/.env values when present", async () => {
    const home = await createTestHome({
      dotenv: "MODEL=test-model\nMAX_STEPS=25\n",
    });

    await withEnv({ MODEL: undefined, MAX_STEPS: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "test-model");
      assert.equal(config.maxSteps, 25);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// minicode home bootstrapping
// ═══════════════════════════════════════════════════════════════════

describe("ensureMinicodeHome (via loadAgentConfig)", () => {
  test("creates the minicode home directory when it does not exist", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "minicode-integ-"));
    tempDirs.push(base);
    const minicodeHome = path.join(base, "fresh-home");

    await withEnv({ MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      await loadAgentConfig("/tmp", { minicodeHome });
    });

    // Directory should exist
    await access(minicodeHome);
    await assert.rejects(access(path.join(minicodeHome, "agent.config.json")));
  });

  test("does not overwrite an existing home .env file", async () => {
    const home = await createTestHome({
      dotenv: "MODEL=my-model\nMAX_STEPS=99\n",
    });

    await withEnv({ MODEL: undefined }, async () => {
      await loadAgentConfig("/tmp", { minicodeHome: home });
    });

    const content = await readFile(path.join(home, ".env"), "utf8");
    assert.match(content, /^MODEL=my-model$/m);
    assert.match(content, /^MAX_STEPS=99$/m);
  });
});

// ═══════════════════════════════════════════════════════════════════
// resolveConfigEnv — precedence tests
// ═══════════════════════════════════════════════════════════════════

describe("resolveConfigEnv precedence", () => {
  test("shell env vars override home .env values", async () => {
    const home = await createTestHome({
      dotenv: "MODEL=dotenv-model\nMAX_STEPS=20\n",
    });

    await withEnv({ MODEL: "shell-model", MAX_STEPS: undefined }, async () => {
      const env = await resolveConfigEnv({ minicodeHome: home });

      // MODEL: shell env wins
      assert.equal(env.values.MODEL, "shell-model");
      assert.equal(env.sources.MODEL, "process");

      // MAX_STEPS: only in .env, so .env value
      assert.equal(env.values.MAX_STEPS, "20");
      assert.equal(env.sources.MAX_STEPS, "home-dotenv");
    });
  });

  test("home .env provides values not in shell env", async () => {
    const home = await createTestHome({
      dotenv: "OPENAI_API_KEY=dotenv-key-123\n",
    });

    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const env = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(env.values.OPENAI_API_KEY, "dotenv-key-123");
      assert.equal(env.sources.OPENAI_API_KEY, "home-dotenv");
    });
  });

  test("shell env var OPENAI_API_KEY overrides home .env", async () => {
    const home = await createTestHome({
      dotenv: "OPENAI_API_KEY=dotenv-key\n",
    });

    await withEnv({ OPENAI_API_KEY: "shell-key-456" }, async () => {
      const env = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(env.values.OPENAI_API_KEY, "shell-key-456");
      assert.equal(env.sources.OPENAI_API_KEY, "process");
    });
  });

  test("empty home .env produces no extra values", async () => {
    const home = await createTestHome({ dotenv: "" });

    await withEnv({ MODEL: "from-shell" }, async () => {
      const env = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(env.values.MODEL, "from-shell");
      assert.equal(env.sources.MODEL, "process");
    });
  });

  test("no .env file at all still works", async () => {
    const home = await createTestHome();

    await withEnv({ MODEL: "shell-only" }, async () => {
      const env = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(env.values.MODEL, "shell-only");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// loadAgentConfig — full precedence chain
// ═══════════════════════════════════════════════════════════════════

describe("loadAgentConfig precedence", () => {
  test("home .env value is used when no shell override exists", async () => {
    const home = await createTestHome({
      config: { model: "config-model", maxSteps: 42 },
    });

    await withEnv({ MODEL: undefined, MAX_STEPS: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "config-model");
      assert.equal(config.maxSteps, 42);
    });
  });

  test("later home .env entries override earlier persisted values", async () => {
    const home = await createTestHome({
      config: { model: "config-model", maxSteps: 42 },
      dotenv: "MODEL=dotenv-model\n",
    });

    await withEnv({ MODEL: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "dotenv-model");
      assert.equal(config.maxSteps, 42);
    });
  });

  test("shell env overrides home .env", async () => {
    const home = await createTestHome({
      config: { model: "config-model", maxSteps: 42 },
      dotenv: "MODEL=dotenv-model\nMAX_STEPS=77\n",
    });

    await withEnv({ MODEL: "shell-model", MAX_STEPS: "99" }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "shell-model");
      assert.equal(config.maxSteps, 99);
    });
  });

  test("OPENAI_API_KEY from shell env is resolved into config", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "test-model",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
    });

    await withEnv({
      MODEL: undefined,
      OPENAI_API_KEY: "sk-test-key-from-shell",
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, "sk-test-key-from-shell");
    });
  });

  test("OPENAI_API_KEY from home .env is resolved when no shell env", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "test-model",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
      dotenv: "OPENAI_API_KEY=sk-dotenv-key\n",
    });

    await withEnv({ OPENAI_API_KEY: undefined, MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, "sk-dotenv-key");
    });
  });

  test("OPENAI_API_KEY from shell overrides home .env", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "test-model",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
      dotenv: "OPENAI_API_KEY=sk-dotenv-key\n",
    });

    await withEnv({ OPENAI_API_KEY: "sk-shell-key", MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, "sk-shell-key");
    });
  });

  test("OPENAI_API_KEY is unset when not provided in env", async () => {
    const home = await createTestHome({
      dotenv: "MODEL_PROVIDER=openai-compatible\nMODEL=test-model\nOPENAI_BASE_URL=http://localhost:1234/v1\n",
    });

    await withEnv({ OPENAI_API_KEY: undefined, MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, undefined);
    });
  });

  test("OpenRouter base URL resolves OPENROUTER_API_KEY with fallback to OPENAI_API_KEY", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "google/gemini-2.5-pro",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
      },
    });

    // When OPENROUTER_API_KEY is set, it takes priority
    await withEnv({
      OPENROUTER_API_KEY: "sk-or-router-key",
      OPENAI_API_KEY: "sk-or-openai-key",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, "sk-or-router-key");
    });

    // When only OPENAI_API_KEY is set, it falls back
    await withEnv({
      OPENROUTER_API_KEY: undefined,
      OPENAI_API_KEY: "sk-or-fallback-key",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.openAiApiKey, "sk-or-fallback-key");
    });
  });

  test("model defaults to empty string when not set anywhere", async () => {
    const home = await createTestHome({ config: {} });

    await withEnv({ MODEL: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "");
    });
  });

  test("modelProvider defaults to openai-compatible", async () => {
    const home = await createTestHome({ config: {} });

    await withEnv({ MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.modelProvider, "openai-compatible");
    });
  });

  test("provider aliases normalize correctly", async () => {
    const home = await createTestHome({ config: {} });

    for (const alias of ["lmstudio", "lm-studio", "openai"]) {
      await withEnv({ MODEL_PROVIDER: alias }, async () => {
        const config = await loadAgentConfig("/tmp", { minicodeHome: home });
        assert.equal(config.modelProvider, "openai-compatible", `alias "${alias}" should normalize`);
      });
    }

    await withEnv({ MODEL_PROVIDER: "anthropic" }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.modelProvider, "anthropic");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// getConfigMissing / getConfigSetupMessage
// ═══════════════════════════════════════════════════════════════════

describe("getConfigMissing and getConfigSetupMessage", () => {
  test("returns empty when model is set and provider is openai-compatible", () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "some-model",
    };
    assert.deepEqual(getConfigMissing(config), []);
    assert.equal(getConfigSetupMessage(config), null);
  });

  test("returns MODEL missing when model is empty string", () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      model: "",
    };
    const missing = getConfigMissing(config);
    assert.ok(missing.some((m) => m.includes("MODEL")));
    assert.notEqual(getConfigSetupMessage(config), null);
  });

  test("returns ANTHROPIC_API_KEY missing for anthropic provider without key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
      };
      const missing = getConfigMissing(config);
      assert.ok(missing.some((m) => m.includes("ANTHROPIC_API_KEY")));
    });
  });

  test("returns no ANTHROPIC_API_KEY missing when key is set", async () => {
    await withEnv({ ANTHROPIC_API_KEY: "sk-ant-test" }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
      };
      const missing = getConfigMissing(config);
      assert.deepEqual(missing, []);
    });
  });

  test("returns no ANTHROPIC_API_KEY missing when session config has key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
        anthropicApiKey: "sk-ant-session",
      };
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("does not require ANTHROPIC_API_KEY for openai-compatible provider", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "openai-compatible" as const,
        model: "some-model",
      };
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("returns OPENROUTER_API_KEY missing for OpenRouter without a key", () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "google/gemini-2.5-flash",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
    };
    const missing = getConfigMissing(config);
    assert.ok(missing.some((m) => m.includes("OPENROUTER_API_KEY")));
  });

  test("does not require OPENROUTER_API_KEY when OpenRouter key is present in config", () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "google/gemini-2.5-flash",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
      openAiApiKey: "sk-or-v1-test",
    };
    assert.deepEqual(getConfigMissing(config), []);
  });

  test("can return multiple missing items simultaneously", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "anthropic" as const,
        model: "",
      };
      const missing = getConfigMissing(config);
      assert.equal(missing.length, 2);
      assert.ok(missing.some((m) => m.includes("MODEL")));
      assert.ok(missing.some((m) => m.includes("ANTHROPIC_API_KEY")));
    });
  });

  test("getConfigSetupMessage includes setup instructions when model is missing", () => {
    const config = { ...createTestAgentConfig("/tmp"), model: "" };
    const message = getConfigSetupMessage(config)!;
    assert.ok(message.includes("MODEL is not set"));
    assert.ok(message.includes("~/.minicode/.env"));
    assert.ok(message.includes("saved back to ~/.minicode/.env"));
  });
});

// ═══════════════════════════════════════════════════════════════════
// End-to-end: loadAgentConfig → getConfigMissing
// ═══════════════════════════════════════════════════════════════════

describe("loadAgentConfig → getConfigMissing integration", () => {
  test("fully configured openai-compatible setup reports no missing items", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "test-model",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
      },
    });

    await withEnv({
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_API_KEY: "sk-test-key",
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("config with model in .env and provider in file reports no missing", async () => {
    const home = await createTestHome({
      config: { modelProvider: "openai-compatible", openAiBaseUrl: "http://localhost:1234/v1" },
      dotenv: "MODEL=env-model\n",
    });

    await withEnv({ MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "env-model");
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("config with missing model triggers setup message", async () => {
    const home = await createTestHome({
      config: { modelProvider: "openai-compatible", openAiBaseUrl: "https://openrouter.ai/api/v1" },
    });

    await withEnv({ MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "");
      const missing = getConfigMissing(config);
      assert.ok(missing.length > 0);
      assert.ok(missing[0]!.includes("MODEL"));
    });
  });

  test("anthropic provider with API key from shell env reports no missing", async () => {
    const home = await createTestHome({
      config: { modelProvider: "anthropic", model: "claude-sonnet-4-20250514" },
    });

    await withEnv({
      ANTHROPIC_API_KEY: "sk-ant-test-123",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("anthropic provider without API key reports missing", async () => {
    const home = await createTestHome({
      config: { modelProvider: "anthropic", model: "claude-sonnet-4-20250514" },
    });

    await withEnv({
      ANTHROPIC_API_KEY: undefined,
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const missing = getConfigMissing(config);
      assert.ok(missing.some((m) => m.includes("ANTHROPIC_API_KEY")));
    });
  });

  test("OpenRouter provider without API key reports missing", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "google/gemini-2.5-flash",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
      },
    });

    await withEnv({
      OPENROUTER_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const missing = getConfigMissing(config);
      assert.ok(missing.some((m) => m.includes("OPENROUTER_API_KEY")));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// /api/status endpoint — needsSetup and missing fields
// ═══════════════════════════════════════════════════════════════════

describe("/api/status needsSetup", () => {
  test("returns needsSetup: false when model is configured", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "test-model",
    };
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge);

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as { needsSetup: boolean; missing: string[] };
    assert.equal(body.needsSetup, false);
    assert.deepEqual(body.missing, []);
  });

  test("returns needsSetup: true with missing items when model is empty", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "",
    };
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge);

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as { needsSetup: boolean; missing: string[] };
    assert.equal(body.needsSetup, true);
    assert.ok(body.missing.length > 0);
    assert.ok(body.missing.some((m: string) => m.includes("MODEL")));
  });

  test("returns needsSetup: true for anthropic without API key", async () => {
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const config = {
        ...createTestAgentConfig("/tmp"),
        modelProvider: "anthropic" as const,
        model: "claude-sonnet-4-20250514",
      };
      const bridge = new ConfigurableBridge(config);
      const base = await startServer(bridge);

      const res = await fetch(`${base}/api/status`);
      const body = await res.json() as { needsSetup: boolean; missing: string[] };
      assert.equal(body.needsSetup, true);
      assert.ok(body.missing.some((m: string) => m.includes("ANTHROPIC_API_KEY")));
    });
  });

  test("returns needsSetup: true for OpenRouter without API key", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "google/gemini-2.5-flash",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
    };
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge);

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as { needsSetup: boolean; missing: string[] };
    assert.equal(body.needsSetup, true);
    assert.ok(body.missing.some((m: string) => m.includes("OPENROUTER_API_KEY")));
  });

  test("status endpoint includes model and provider info", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "my-test-model",
    };
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge);

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as { model: string; provider: string };
    assert.equal(body.model, "my-test-model");
    assert.equal(body.provider, "openai-compatible");
  });

  test("status endpoint reports no configured provider for a fresh install using defaults", async () => {
    const baseDir = await mkdtemp(path.join(os.tmpdir(), "minicode-integ-"));
    tempDirs.push(baseDir);
    const minicodeHome = path.join(baseDir, "new-home");
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "openai-compatible" as const,
      model: "",
      openAiBaseUrl: "http://localhost:1234/v1",
    };
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge, { minicodeHome });

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as {
      configuredProvider: "anthropic" | "openrouter" | "openai-compatible" | null;
      needsSetup: boolean;
      missing: string[];
    };
    assert.equal(body.configuredProvider, null);
    assert.equal(body.needsSetup, true);
    assert.ok(body.missing.some((m: string) => m.includes("MODEL")));
  });

  test("status endpoint reports openai-compatible when localhost is explicitly configured", async () => {
    const minicodeHome = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
    });
    const config = await loadAgentConfig("/tmp", { minicodeHome });
    const bridge = new ConfigurableBridge(config);
    const base = await startServer(bridge, { minicodeHome });

    const res = await fetch(`${base}/api/status`);
    const body = await res.json() as {
      configuredProvider: "anthropic" | "openrouter" | "openai-compatible" | null;
      needsSetup: boolean;
      missing: string[];
    };
    assert.equal(body.configuredProvider, "openai-compatible");
    assert.equal(body.needsSetup, true);
    assert.ok(body.missing.some((m: string) => m.includes("MODEL")));
  });
});

// ═══════════════════════════════════════════════════════════════════
// /api/context — graceful degradation when agent not ready
// ═══════════════════════════════════════════════════════════════════

describe("/api/context graceful degradation", () => {
  test("returns zeros when bridge is not ready", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      model: "",
    };
    const bridge = new ConfigurableBridge(config, false);
    const base = await startServer(bridge);

    const res = await fetch(`${base}/api/context`);
    assert.equal(res.status, 200);
    const body = await res.json() as { contextTokens: number; maxContextTokens: number };
    assert.equal(body.contextTokens, 0);
    assert.equal(body.maxContextTokens, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// buildStructuredConfigPayload — env source tracking
// ═══════════════════════════════════════════════════════════════════

describe("buildStructuredConfigPayload env source tracking", () => {
  test("reports env override from process when shell env var is set", async () => {
    const home = await createTestHome({
      config: { model: "file-model" },
    });

    await withEnv({ MODEL: "shell-model", MAX_STEPS: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const payload = await buildStructuredConfigPayload(config, home);

      const modelEntry = payload.entries.find((e) => e.key === "model")!;
      assert.equal(modelEntry.overriddenByEnv, true);
      assert.equal(modelEntry.envValue, "shell-model");
      assert.equal(modelEntry.envSource, "process");
    });
  });

  test("treats ~/.minicode/.env as persisted settings rather than an override", async () => {
    const home = await createTestHome({
      config: { model: "file-model" },
      dotenv: "MAX_STEPS=88\n",
    });

    await withEnv({ MAX_STEPS: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const payload = await buildStructuredConfigPayload(config, home);

      const maxStepsEntry = payload.entries.find((e) => e.key === "maxSteps")!;
      assert.equal(maxStepsEntry.overriddenByEnv, false);
      assert.equal(maxStepsEntry.persistedValue, 88);
      assert.equal(maxStepsEntry.envValue, null);
      assert.equal(maxStepsEntry.envSource, null);
      assert.equal(maxStepsEntry.envSourcePath, null);
    });
  });

  test("shows home .env values as both effective and persisted", async () => {
    const home = await createTestHome({
      config: { maxSteps: 42 },
    });

    await withEnv({ MAX_STEPS: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const payload = await buildStructuredConfigPayload(config, home);

      const maxStepsEntry = payload.entries.find((e) => e.key === "maxSteps")!;
      assert.equal(maxStepsEntry.overriddenByEnv, false);
      assert.equal(maxStepsEntry.effectiveValue, 42);
      assert.equal(maxStepsEntry.persistedValue, 42);
    });
  });

  test("OPENAI_API_KEY from shell env appears in structured payload", async () => {
    const home = await createTestHome({
      config: { model: "test-model" },
    });

    await withEnv({ OPENAI_API_KEY: "sk-test-in-payload", MODEL: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const payload = await buildStructuredConfigPayload(config, home);

      const baseUrlEntry = payload.entries.find((e) => e.envVar === "OPENAI_BASE_URL")!;
      assert.ok(baseUrlEntry, "should have OPENAI_BASE_URL entry");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Realistic user scenario tests
// ═══════════════════════════════════════════════════════════════════

describe("realistic user scenarios", () => {
  test("OpenRouter setup: home .env + shell OPENAI_API_KEY → no setup needed", async () => {
    // User has modelProvider and openAiBaseUrl in config, OPENAI_API_KEY in shell
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "google/gemini-2.5-pro",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
        maxSteps: 50,
        maxTokens: 4096,
        maxContextTokens: 32000,
      },
    });

    await withEnv({
      OPENAI_API_KEY: "sk-or-test-key",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });

      // Verify all values are correct
      assert.equal(config.modelProvider, "openai-compatible");
      assert.equal(config.model, "google/gemini-2.5-pro");
      assert.equal(config.openAiBaseUrl, "https://openrouter.ai/api/v1");
      assert.equal(config.openAiApiKey, "sk-or-test-key");

      // Should NOT need setup
      assert.deepEqual(getConfigMissing(config), []);
      assert.equal(getConfigSetupMessage(config), null);
    });
  });

  test("OpenRouter setup missing model → setup required with specific error", async () => {
    // User has provider and URL but forgot the model name
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
        maxSteps: 50,
        maxTokens: 4096,
        maxContextTokens: 32000,
      },
    });

    await withEnv({
      OPENAI_API_KEY: "sk-or-test-key",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });

      assert.equal(config.model, "");
      const missing = getConfigMissing(config);
      assert.equal(missing.length, 1);
      assert.ok(missing[0]!.includes("MODEL"));
    });
  });

  test("local LM Studio setup: only home .env, no shell env vars needed", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        model: "qwen2.5-coder-7b",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
    });

    await withEnv({
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.model, "qwen2.5-coder-7b");
      assert.equal(config.openAiBaseUrl, "http://localhost:1234/v1");
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("anthropic setup: model in config, API key in shell", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "anthropic",
        model: "claude-sonnet-4-20250514",
      },
    });

    await withEnv({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      assert.equal(config.modelProvider, "anthropic");
      assert.equal(config.model, "claude-sonnet-4-20250514");
      assert.deepEqual(getConfigMissing(config), []);
    });
  });

  test("fresh install: missing model still triggers setup overlay", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "minicode-integ-"));
    tempDirs.push(base);
    const minicodeHome = path.join(base, "new-home");

    await withEnv({ MODEL: undefined, MODEL_PROVIDER: undefined }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome });

      await access(minicodeHome);
      await assert.rejects(access(path.join(minicodeHome, "agent.config.json")));

      // Empty model → needs setup
      assert.equal(config.model, "");
      const missing = getConfigMissing(config);
      assert.ok(missing.length > 0);
    });
  });
});

describe("getConfiguredProvider", () => {
  test("returns null for a fresh install using only fallback localhost defaults", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "minicode-integ-"));
    tempDirs.push(base);
    const minicodeHome = path.join(base, "new-home");

    await withEnv({
      MODEL: undefined,
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome });
      const resolvedEnv = await resolveConfigEnv({ minicodeHome });
      assert.equal(getConfiguredProvider(config, resolvedEnv.values), null);
    });
  });

  test("returns openrouter when OpenRouter is explicitly configured", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        openAiBaseUrl: "https://openrouter.ai/api/v1",
      },
      dotenv: "OPENROUTER_API_KEY=sk-or-test-key\n",
    });

    await withEnv({
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const resolvedEnv = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(getConfiguredProvider(config, resolvedEnv.values), "openrouter");
    });
  });

  test("returns openai-compatible when a local endpoint is explicitly configured", async () => {
    const home = await createTestHome({
      config: {
        modelProvider: "openai-compatible",
        openAiBaseUrl: "http://localhost:1234/v1",
      },
    });

    await withEnv({
      MODEL_PROVIDER: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: undefined,
    }, async () => {
      const config = await loadAgentConfig("/tmp", { minicodeHome: home });
      const resolvedEnv = await resolveConfigEnv({ minicodeHome: home });
      assert.equal(getConfiguredProvider(config, resolvedEnv.values), "openai-compatible");
    });
  });

  test("returns anthropic when session config has an Anthropic key", async () => {
    const config = {
      ...createTestAgentConfig("/tmp"),
      modelProvider: "anthropic" as const,
      anthropicApiKey: "sk-ant-session",
    };

    assert.equal(getConfiguredProvider(config, {}), "anthropic");
  });
});
