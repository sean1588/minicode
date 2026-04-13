import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  getGlobalConfigPath,
  setPersistedConfigValue,
  unsetPersistedConfigValue,
} from "../src/agent/editable-config.js";
import { handleConfigSlashCommand } from "../src/cli/config-slash-command.js";
import { createTestAgentConfig } from "./test-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("setPersistedConfigValue writes mapped keys and unset removes empty config files", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-config-"));
  tempDirs.push(home);

  const setResult = await setPersistedConfigValue({
    minicodeHome: home,
    key: "commandTimeoutMs",
    rawValue: "45000",
  });

  assert.equal(setResult.path, path.join(home, ".env"));
  const file = await readFile(setResult.path, "utf8");
  assert.match(file, /^COMMAND_TIMEOUT_MS=45000$/m);

  await unsetPersistedConfigValue({
    minicodeHome: home,
    key: "commandTimeoutMs",
  });

  const updated = await readFile(setResult.path, "utf8");
  assert.doesNotMatch(updated, /^COMMAND_TIMEOUT_MS=/m);
});

test("handleConfigSlashCommand persists config and reports env overrides", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-config-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "minicode-config-ws-"));
  tempDirs.push(home, workspace);
  const config = createTestAgentConfig(workspace);
  const previous = process.env.MAX_STEPS;

  try {
    process.env.MAX_STEPS = "120";
    const result = await handleConfigSlashCommand("/config set maxSteps 64", {
      config,
      minicodeHome: home,
    });

    assert.equal(result.handled, true);
    assert.match(result.message ?? "", /Saved config: maxSteps = 64/);
    assert.match(result.message ?? "", /MAX_STEPS is currently exported in your shell/);

    const persisted = await readFile(path.join(home, ".env"), "utf8");
    assert.match(persisted, /^MAX_STEPS=64$/m);
  } finally {
    if (previous === undefined) {
      delete process.env.MAX_STEPS;
    } else {
      process.env.MAX_STEPS = previous;
    }
  }
});

test("handleConfigSlashCommand reports config layers with /config get", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-config-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "minicode-config-ws-"));
  tempDirs.push(home, workspace);
  const config = {
    ...createTestAgentConfig(workspace),
    modelProvider: "openai-compatible" as const,
  };
  const previous = process.env.MODEL_PROVIDER;

  try {
    process.env.MODEL_PROVIDER = "openai-compatible";
    await setPersistedConfigValue({
      minicodeHome: home,
      key: "modelProvider",
      rawValue: "openai-compatible",
    });

    const getResult = await handleConfigSlashCommand("/config get modelProvider", {
      config,
      minicodeHome: home,
    });

    assert.equal(getResult.handled, true);
    assert.match(getResult.message ?? "", /effective: openai-compatible/);
    assert.match(getResult.message ?? "", /saved in ~\/\.minicode\/\.env: openai-compatible/);
    assert.match(getResult.message ?? "", /exported env override \(MODEL_PROVIDER\): openai-compatible/);
  } finally {
    if (previous === undefined) {
      delete process.env.MODEL_PROVIDER;
    } else {
      process.env.MODEL_PROVIDER = previous;
    }
  }
});

test("handleConfigSlashCommand rejects non-editable keys and keeps secrets env-only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-config-"));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "minicode-config-ws-"));
  tempDirs.push(home, workspace);
  const result = await handleConfigSlashCommand("/config set openAiApiKey secret", {
    config: createTestAgentConfig(workspace),
    minicodeHome: home,
  });

  assert.equal(result.handled, true);
  assert.match(result.message ?? "", /Unknown editable config key "openAiApiKey"/);
  assert.match(result.message ?? "", /Secrets like API keys stay env-only for now/);
});

test("getGlobalConfigPath resolves to minicode home", () => {
  const home = "/tmp/example-home";
  assert.equal(
    getGlobalConfigPath(home),
    path.join(home, ".env"),
  );
});
