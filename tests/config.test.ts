import assert from "node:assert/strict";
import { test } from "node:test";

import { loadAgentConfig } from "../src/agent/config.js";

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
