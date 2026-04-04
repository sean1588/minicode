import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  applyPersistedConfigUpdates,
  buildStructuredConfigPayload,
  getGlobalConfigPath,
} from "../src/agent/editable-config.js";
import { createTestAgentConfig } from "./test-utils.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

test("buildStructuredConfigPayload reports effective values and env overrides", async () => {
  await withUnsetEnvVars(["MAX_STEPS", "MODEL", "ENABLE_DYNAMIC_PROMPT"], async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-config-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-ws-"));
    tempDirs.push(home, workspace);

    await applyPersistedConfigUpdates({
      minicodeHome: home,
      updates: {
        maxSteps: 77,
        model: "global-model",
      },
    });

    process.env.MAX_STEPS = "120";

    const payload = await buildStructuredConfigPayload(
      {
        ...createTestAgentConfig(workspace),
        maxSteps: 120,
        model: "global-model",
      },
      home,
    );

    assert.equal(payload.configPath, path.join(home, "agent.config.json"));

    const maxSteps = payload.entries.find((entry) => entry.key === "maxSteps");
    assert.equal(maxSteps?.effectiveValue, 120);
    assert.equal(maxSteps?.persistedValue, 77);
    assert.equal(maxSteps?.envValue, "120");
    assert.equal(maxSteps?.envSource, "process");
    assert.equal(maxSteps?.envSourcePath, null);
    assert.equal(maxSteps?.overriddenByEnv, true);

    const model = payload.entries.find((entry) => entry.key === "model");
    assert.equal(model?.effectiveValue, "global-model");
    assert.equal(model?.persistedValue, "global-model");
    assert.equal(model?.overriddenByEnv, false);
  });
});

test("buildStructuredConfigPayload reports home dotenv env source", async () => {
  await withUnsetEnvVars(["MAX_STEPS"], async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-config-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-ws-"));
    tempDirs.push(home, workspace);

    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, ".env"), "MAX_STEPS=88\n", "utf8");

    const payload = await buildStructuredConfigPayload(
      {
        ...createTestAgentConfig(workspace),
        maxSteps: 88,
      },
      home,
    );

    const maxSteps = payload.entries.find((entry) => entry.key === "maxSteps");
    assert.equal(maxSteps?.envValue, "88");
    assert.equal(maxSteps?.envSource, "home-dotenv");
    assert.equal(maxSteps?.envSourcePath, path.join(home, ".env"));
    assert.equal(maxSteps?.overriddenByEnv, true);
  });
});

test("applyPersistedConfigUpdates writes global config and removes files when everything is unset", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "minicode-editable-config-"));
  tempDirs.push(home);

  const result = await applyPersistedConfigUpdates({
    minicodeHome: home,
    updates: {
      keepRecentMessages: 18,
      enableFileReadDedup: false,
    },
  });

  assert.equal(result.path, getGlobalConfigPath(home));
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
    minicodeHome: home,
    updates: {
      keepRecentMessages: null,
      enableFileReadDedup: null,
    },
  });

  await assert.rejects(access(configPath));
});
