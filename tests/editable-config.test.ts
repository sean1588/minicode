import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  applyPersistedConfigUpdates,
  buildStructuredConfigPayload,
  getConfigPathForScope,
} from "../src/agent/editable-config.js";
import { createTestAgentConfig } from "./test-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempPaths(): Promise<{ workspace: string; home: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-config-"));
  const workspace = path.join(base, "workspace");
  const home = path.join(base, "home");
  tempDirs.push(base);
  return { workspace, home };
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

test("buildStructuredConfigPayload reports effective values, scope layers, and env overrides", async () => {
  await withUnsetEnvVars(["MAX_STEPS", "MODEL", "ENABLE_DYNAMIC_PROMPT"], async () => {
    const { workspace, home } = await createTempPaths();

    await applyPersistedConfigUpdates({
      cwd: workspace,
      minicodeHome: home,
      scope: "global",
      updates: {
        maxSteps: 77,
        model: "global-model",
      },
    });
    await applyPersistedConfigUpdates({
      cwd: workspace,
      minicodeHome: home,
      scope: "workspace",
      updates: {
        model: "workspace-model",
        enableDynamicPrompt: false,
      },
    });

    process.env.MAX_STEPS = "120";

    const payload = await buildStructuredConfigPayload(
      {
        ...createTestAgentConfig(workspace),
        maxSteps: 120,
        model: "workspace-model",
        enableDynamicPrompt: false,
      },
      workspace,
      home,
    );

    assert.equal(payload.workspaceConfigPath, path.join(workspace, "agent.config.json"));
    assert.equal(payload.globalConfigPath, path.join(home, "agent.config.json"));

    const maxSteps = payload.entries.find((entry) => entry.key === "maxSteps");
    assert.equal(maxSteps?.effectiveValue, 120);
    assert.equal(maxSteps?.workspaceValue, null);
    assert.equal(maxSteps?.globalValue, 77);
    assert.equal(maxSteps?.envValue, "120");
    assert.equal(maxSteps?.overriddenByEnv, true);

    const model = payload.entries.find((entry) => entry.key === "model");
    assert.equal(model?.effectiveValue, "workspace-model");
    assert.equal(model?.workspaceValue, "workspace-model");
    assert.equal(model?.globalValue, "global-model");
    assert.equal(model?.overriddenByEnv, false);
  });
});

test("applyPersistedConfigUpdates writes global scope and removes files when everything is unset", async () => {
  const { workspace, home } = await createTempPaths();

  const result = await applyPersistedConfigUpdates({
    cwd: workspace,
    minicodeHome: home,
    scope: "global",
    updates: {
      keepRecentMessages: 18,
      enableFileReadDedup: false,
    },
  });

  assert.equal(result.path, getConfigPathForScope(workspace, "global", home));
  assert.deepEqual(result.saved, [
    { key: "keepRecentMessages", value: 18 },
    { key: "enableFileReadDedup", value: false },
  ]);

  const configPath = path.join(home, "agent.config.json");
  const persisted = JSON.parse(await readFile(configPath, "utf8")) as {
    keepRecentMessages: number;
    enableFileReadDedup: boolean;
  };
  assert.equal(persisted.keepRecentMessages, 18);
  assert.equal(persisted.enableFileReadDedup, false);

  await applyPersistedConfigUpdates({
    cwd: workspace,
    minicodeHome: home,
    scope: "global",
    updates: {
      keepRecentMessages: null,
      enableFileReadDedup: null,
    },
  });

  await assert.rejects(access(configPath));
});
