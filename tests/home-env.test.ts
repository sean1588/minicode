import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { getHomeEnvPath, upsertHomeEnvValues } from "../src/agent/home-env.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("upsertHomeEnvValues creates ~/.minicode/.env when missing", async () => {
  const minicodeHome = await mkdtemp(path.join(os.tmpdir(), "minicode-home-env-"));
  tempDirs.push(minicodeHome);

  const result = await upsertHomeEnvValues({
    minicodeHome,
    values: {
      MODEL_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "sk-or-v1-test",
    },
  });

  assert.equal(result.path, getHomeEnvPath(minicodeHome));
  const contents = await readFile(result.path, "utf8");
  assert.match(contents, /^MODEL_PROVIDER=openai-compatible/m);
  assert.match(contents, /^OPENAI_BASE_URL=https:\/\/openrouter\.ai\/api\/v1/m);
  assert.match(contents, /^OPENROUTER_API_KEY=sk-or-v1-test/m);
});

test("upsertHomeEnvValues replaces existing keys and preserves unrelated lines", async () => {
  const minicodeHome = await mkdtemp(path.join(os.tmpdir(), "minicode-home-env-"));
  tempDirs.push(minicodeHome);
  const envPath = getHomeEnvPath(minicodeHome);

  await writeFile(
    envPath,
    [
      "# Existing config",
      "MODEL_PROVIDER=anthropic",
      "OPENAI_BASE_URL=https://example.invalid/v1",
      "OPENROUTER_API_KEY=old-key",
      "OPENROUTER_API_KEY=older-key",
      "MODEL=existing-model",
      "",
    ].join("\n"),
    "utf8",
  );

  await upsertHomeEnvValues({
    minicodeHome,
    values: {
      MODEL_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "sk-or-v1-new",
    },
  });

  const contents = await readFile(envPath, "utf8");
  assert.match(contents, /^# Existing config/m);
  assert.match(contents, /^MODEL_PROVIDER=openai-compatible$/m);
  assert.match(contents, /^OPENAI_BASE_URL=https:\/\/openrouter\.ai\/api\/v1$/m);
  assert.match(contents, /^OPENROUTER_API_KEY=sk-or-v1-new$/m);
  assert.match(contents, /^MODEL=existing-model$/m);
  assert.equal(contents.match(/^OPENROUTER_API_KEY=/gm)?.length, 1);
});
