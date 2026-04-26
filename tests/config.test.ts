import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { loadAgentConfig } from "../src/agent/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("loadAgentConfig normalizes openai-compatible provider aliases", async () => {
  const previousProvider = process.env.MODEL_PROVIDER;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousModel = process.env.MODEL;

  try {
    process.env.MODEL_PROVIDER = "lmstudio";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:1234/v1";
    process.env.MODEL = "qwen2.5-coder-7b-instruct";

    const config = await loadAgentConfig("/tmp");
    assert.equal(config.modelProvider, "openai-compatible");
    assert.equal(config.openAiBaseUrl, "http://127.0.0.1:1234/v1");
    assert.equal(config.model, "qwen2.5-coder-7b-instruct");
  } finally {
    if (previousProvider === undefined) {
      delete process.env.MODEL_PROVIDER;
    } else {
      process.env.MODEL_PROVIDER = previousProvider;
    }
    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
    if (previousModel === undefined) {
      delete process.env.MODEL;
    } else {
      process.env.MODEL = previousModel;
    }
  }
});

test("loadAgentConfig uses global config and env vars with correct precedence", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-test-"));
  tempDirs.push(base);

  const minicodeHome = path.join(base, "home");
  await mkdir(minicodeHome, { recursive: true });

  await writeFile(
    path.join(minicodeHome, ".env"),
    "MODEL=home-env-model\nMAX_STEPS=33\n",
    "utf8",
  );

  const previousMaxSteps = process.env.MAX_STEPS;
  const previousModel = process.env.MODEL;

  try {
    // Shell env vars should override everything
    process.env.MAX_STEPS = "120";
    delete process.env.MODEL;

    const config = await loadAgentConfig("/tmp", { minicodeHome });

    assert.equal(config.model, "home-env-model");
    assert.equal(config.maxSteps, 120);
  } finally {
    if (previousMaxSteps === undefined) {
      delete process.env.MAX_STEPS;
    } else {
      process.env.MAX_STEPS = previousMaxSteps;
    }
    if (previousModel === undefined) {
      delete process.env.MODEL;
    } else {
      process.env.MODEL = previousModel;
    }
  }
});

test("loadAgentConfig appends COMMAND_DENYLIST patterns from env", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-test-"));
  tempDirs.push(base);

  const minicodeHome = path.join(base, "home");
  await mkdir(minicodeHome, { recursive: true });
  await writeFile(
    path.join(minicodeHome, ".env"),
    'MODEL=test-model\nCOMMAND_DENYLIST=["custom-danger","^wipe-db$"]\n',
    "utf8",
  );

  const config = await loadAgentConfig("/tmp", { minicodeHome });
  const serialized = config.commandDenylist.map((pattern) => pattern.source);

  assert.ok(serialized.includes("custom-danger"));
  assert.ok(serialized.includes("^wipe-db$"));
});

test("loadAgentConfig reads model start timeout in seconds", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-test-"));
  tempDirs.push(base);

  const minicodeHome = path.join(base, "home");
  await mkdir(minicodeHome, { recursive: true });
  await writeFile(
    path.join(minicodeHome, ".env"),
    "MODEL=test-model\nMODEL_TIMEOUT_SECONDS=75\n",
    "utf8",
  );

  const config = await loadAgentConfig("/tmp", { minicodeHome });
  assert.equal(config.modelTimeoutSeconds, 75);
});

test("loadAgentConfig disables dynamic prompts by default", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-test-"));
  tempDirs.push(base);

  const minicodeHome = path.join(base, "home");
  await mkdir(minicodeHome, { recursive: true });
  await writeFile(
    path.join(minicodeHome, ".env"),
    "MODEL=test-model\n",
    "utf8",
  );

  const previousDynamicPrompt = process.env.ENABLE_DYNAMIC_PROMPT;
  try {
    delete process.env.ENABLE_DYNAMIC_PROMPT;
    const config = await loadAgentConfig("/tmp", { minicodeHome });
    assert.equal(config.enableDynamicPrompt, false);
  } finally {
    if (previousDynamicPrompt === undefined) {
      delete process.env.ENABLE_DYNAMIC_PROMPT;
    } else {
      process.env.ENABLE_DYNAMIC_PROMPT = previousDynamicPrompt;
    }
  }
});
