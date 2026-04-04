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

test("loadAgentConfig can ignore workspace config while still honoring global config and env overrides", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-test-"));
  tempDirs.push(base);

  const workspace = path.join(base, "workspace");
  const minicodeHome = path.join(base, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(minicodeHome, { recursive: true });

  await writeFile(
    path.join(minicodeHome, "agent.config.json"),
    JSON.stringify({ model: "global-model", maxSteps: 33 }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(minicodeHome, ".env"),
    "MODEL=home-env-model\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace, "agent.config.json"),
    JSON.stringify({ model: "workspace-model", maxSteps: 99 }, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(workspace, ".env"),
    "MODEL=workspace-env-model\nMAX_STEPS=200\n",
    "utf8",
  );

  const previousMaxSteps = process.env.MAX_STEPS;
  const previousModel = process.env.MODEL;

  try {
    process.env.MAX_STEPS = "120";
    delete process.env.MODEL;

    const config = await loadAgentConfig(workspace, {
      includeWorkspaceConfig: false,
      includeWorkspaceEnv: false,
      minicodeHome,
    });

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
