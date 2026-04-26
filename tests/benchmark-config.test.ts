import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  buildBenchmarkAgentConfig,
  getDefaultBenchmarkConfigPath,
} from "../src/benchmark/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("getDefaultBenchmarkConfigPath resolves under benchmarks/", () => {
  const repoRoot = "/tmp/minicode-repo";
  assert.equal(
    getDefaultBenchmarkConfigPath(repoRoot),
    path.join(repoRoot, "benchmarks", "benchmark.config.json"),
  );
});

test("buildBenchmarkAgentConfig uses config, env files, shell env, and CLI overrides in precedence order", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-benchmark-config-"));
  tempDirs.push(repoRoot);

  const configPath = path.join(repoRoot, "benchmarks", "benchmark.config.json");
  const envFilePath = path.join(repoRoot, "benchmarks", "benchmark.env");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      modelProvider: "openai-compatible",
      model: "config-model",
      openAiBaseUrl: "https://config.example/v1",
      workspaceRoot: "./config-workspace",
      maxSteps: 11,
      maxContextTokens: 12000,
      commandTimeoutMs: 4000,
      enableDynamicPrompt: true,
    }),
    "utf8",
  );
  await writeFile(
    envFilePath,
    [
      "MODEL=env-file-model",
      "OPENAI_BASE_URL=https://env-file.example/v1",
      "OPENAI_API_KEY=env-file-key",
      "MAX_STEPS=22",
      "ENABLE_DYNAMIC_PROMPT=true",
    ].join("\n"),
    "utf8",
  );

  const config = await buildBenchmarkAgentConfig({
    cwd: repoRoot,
    configPath: path.relative(repoRoot, configPath),
    envFiles: [path.relative(repoRoot, envFilePath)],
    env: {
      MODEL: "shell-model",
      MAX_STEPS: "33",
      MAX_CONTEXT_TOKENS: "24000",
      OPENAI_API_KEY: "shell-key",
    },
    overrides: {
      model: "override-model",
      baseUrl: "https://override.example/v1",
      workspaceRoot: "./override-workspace",
    },
  });

  assert.equal(config.modelProvider, "openai-compatible");
  assert.equal(config.model, "override-model");
  assert.equal(config.openAiBaseUrl, "https://override.example/v1");
  assert.equal(config.workspaceRoot, path.join(repoRoot, "override-workspace"));
  assert.equal(config.maxSteps, 33);
  assert.equal(config.maxContextTokens, 24000);
  assert.equal(config.commandTimeoutMs, 4000);
  assert.equal(config.openAiApiKey, "shell-key");
  assert.equal(config.enableDynamicPrompt, true);
});

test("buildBenchmarkAgentConfig does not require a default config file", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "minicode-benchmark-config-"));
  tempDirs.push(repoRoot);

  const config = await buildBenchmarkAgentConfig({
    cwd: repoRoot,
    env: {
      MODEL_PROVIDER: "openai-compatible",
      MODEL: "standalone-model",
      OPENAI_BASE_URL: "http://localhost:1234/v1",
    },
  });

  assert.equal(config.modelProvider, "openai-compatible");
  assert.equal(config.model, "standalone-model");
  assert.equal(config.openAiBaseUrl, "http://localhost:1234/v1");
  assert.equal(config.maxSteps, 50);
  assert.equal(config.enableDynamicPrompt, false);
});
