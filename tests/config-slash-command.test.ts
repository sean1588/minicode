import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  getConfigPathForScope,
  setPersistedConfigValue,
  unsetPersistedConfigValue,
} from "../src/agent/editable-config.js";
import { handleConfigSlashCommand } from "../src/cli/config-slash-command.js";
import { createTestAgentConfig } from "./test-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempPaths(): Promise<{ workspace: string; home: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-config-"));
  const workspace = path.join(base, "workspace");
  const home = path.join(base, "home");
  tempDirs.push(base);
  return { workspace, home };
}

test("setPersistedConfigValue writes mapped keys and unset removes empty config files", async () => {
  const { workspace, home } = await createTempPaths();

  const setResult = await setPersistedConfigValue({
    cwd: workspace,
    minicodeHome: home,
    key: "commandTimeoutMs",
    rawValue: "45000",
  });

  assert.equal(setResult.path, path.join(workspace, "agent.config.json"));
  const file = JSON.parse(await readFile(setResult.path, "utf8")) as { commandTimeout: number };
  assert.equal(file.commandTimeout, 45000);

  await unsetPersistedConfigValue({
    cwd: workspace,
    minicodeHome: home,
    key: "commandTimeoutMs",
  });

  await assert.rejects(access(setResult.path));
});

test("handleConfigSlashCommand persists workspace config and reports env overrides", async () => {
  const { workspace, home } = await createTempPaths();
  const config = createTestAgentConfig(workspace);
  const previous = process.env.MAX_STEPS;

  try {
    process.env.MAX_STEPS = "120";
    const result = await handleConfigSlashCommand("/config set maxSteps 64", {
      config,
      cwd: workspace,
      minicodeHome: home,
    });

    assert.equal(result.handled, true);
    assert.match(result.message ?? "", /Saved workspace config: maxSteps = 64/);
    assert.match(result.message ?? "", /MAX_STEPS is currently set/);

    const persisted = JSON.parse(
      await readFile(path.join(workspace, "agent.config.json"), "utf8"),
    ) as { maxSteps: number };
    assert.equal(persisted.maxSteps, 64);
  } finally {
    if (previous === undefined) {
      delete process.env.MAX_STEPS;
    } else {
      process.env.MAX_STEPS = previous;
    }
  }
});

test("handleConfigSlashCommand supports --global and reports config layers with /config get", async () => {
  const { workspace, home } = await createTempPaths();
  const config = {
    ...createTestAgentConfig(workspace),
    modelProvider: "openai-compatible" as const,
  };
  const previous = process.env.MODEL_PROVIDER;

  try {
    process.env.MODEL_PROVIDER = "openai-compatible";
    await setPersistedConfigValue({
      cwd: workspace,
      minicodeHome: home,
      key: "modelProvider",
      rawValue: "anthropic",
      scope: "workspace",
    });

    const setGlobal = await handleConfigSlashCommand("/config set --global modelProvider openai-compatible", {
      config,
      cwd: workspace,
      minicodeHome: home,
    });
    assert.match(setGlobal.message ?? "", /Saved global config: modelProvider = openai-compatible/);

    const getResult = await handleConfigSlashCommand("/config get modelProvider", {
      config,
      cwd: workspace,
      minicodeHome: home,
    });

    assert.equal(getResult.handled, true);
    assert.match(getResult.message ?? "", /effective: openai-compatible/);
    assert.match(getResult.message ?? "", /workspace file: anthropic/);
    assert.match(getResult.message ?? "", /global file: openai-compatible/);
    assert.match(getResult.message ?? "", /env override \(MODEL_PROVIDER\): openai-compatible/);
  } finally {
    if (previous === undefined) {
      delete process.env.MODEL_PROVIDER;
    } else {
      process.env.MODEL_PROVIDER = previous;
    }
  }
});

test("handleConfigSlashCommand rejects non-editable keys and keeps secrets env-only", async () => {
  const { workspace, home } = await createTempPaths();
  const result = await handleConfigSlashCommand("/config set openAiApiKey secret", {
    config: createTestAgentConfig(workspace),
    cwd: workspace,
    minicodeHome: home,
  });

  assert.equal(result.handled, true);
  assert.match(result.message ?? "", /Unknown editable config key "openAiApiKey"/);
  assert.match(result.message ?? "", /Secrets like API keys stay env-only for now/);
});

test("getConfigPathForScope resolves workspace and global paths", () => {
  const workspace = "/tmp/example-workspace";
  const home = "/tmp/example-home";

  assert.equal(
    getConfigPathForScope(workspace, "workspace", home),
    path.join(workspace, "agent.config.json"),
  );
  assert.equal(
    getConfigPathForScope(workspace, "global", home),
    path.join(home, "agent.config.json"),
  );
});
