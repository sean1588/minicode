import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { parseArgs, buildConfig, loadTasks, getBenchmarkConfigPath } from "../scripts/run-benchmarks.js";

// ─── parseArgs ────────────────────────────────────────────────────

test("parseArgs: defaults to variant 'ci' with no flags", () => {
  const args = parseArgs([]);
  assert.equal(args.variant, "ci");
  assert.equal(args.category, undefined);
  assert.equal(args.task, undefined);
  assert.equal(args.out, undefined);
});

test("parseArgs: parses --variant flag", () => {
  const args = parseArgs(["--variant", "nightly"]);
  assert.equal(args.variant, "nightly");
});

test("parseArgs: parses --category flag", () => {
  const args = parseArgs(["--category", "navigation"]);
  assert.equal(args.category, "navigation");
});

test("parseArgs: parses --task flag", () => {
  const args = parseArgs(["--task", "navigation/find-symbol-definition"]);
  assert.equal(args.task, "navigation/find-symbol-definition");
});

test("parseArgs: parses --out flag", () => {
  const args = parseArgs(["--out", "report.json"]);
  assert.equal(args.out, "report.json");
});

test("parseArgs: parses all flags together", () => {
  const args = parseArgs([
    "--category", "editing",
    "--variant", "v2",
    "--out", "/tmp/report.json",
  ]);
  assert.equal(args.category, "editing");
  assert.equal(args.variant, "v2");
  assert.equal(args.out, "/tmp/report.json");
});

test("parseArgs: ignores unknown flags", () => {
  const args = parseArgs(["--unknown", "value", "--variant", "test"]);
  assert.equal(args.variant, "test");
});

// ─── buildConfig ──────────────────────────────────────────────────

test("getBenchmarkConfigPath resolves under benchmarks/", () => {
  const repoRoot = "/tmp/minicode-repo";
  assert.equal(
    getBenchmarkConfigPath(repoRoot),
    path.join(repoRoot, "benchmarks", "benchmark.config.json"),
  );
});

test("buildConfig: reads benchmark config file defaults", async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-config-root-"));
  const configPath = path.join(tmpRoot, "benchmarks", "benchmark.config.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      modelProvider: "openai-compatible",
      model: "google/gemini-3-flash-preview",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
      maxSteps: 42,
      maxContextTokens: 12345,
    }),
  );

  try {
    const config = buildConfig({
      repoRoot: tmpRoot,
      env: {},
      homeEnvPath: path.join(tmpRoot, ".missing-home-env"),
      configPath,
    });
    assert.equal(config.modelProvider, "openai-compatible");
    assert.equal(config.model, "google/gemini-3-flash-preview");
    assert.equal(config.openAiBaseUrl, "https://openrouter.ai/api/v1");
    assert.equal(config.maxSteps, 42);
    assert.equal(config.maxContextTokens, 12345);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("buildConfig: home .env provides benchmark API keys", async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-config-home-env-"));
  const configPath = path.join(tmpRoot, "benchmarks", "benchmark.config.json");
  const homeEnvPath = path.join(tmpRoot, "home.env");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      modelProvider: "openai-compatible",
      model: "google/gemini-3-flash-preview",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
    }),
  );
  await writeFile(homeEnvPath, "OPENROUTER_API_KEY=test-openrouter-key\n");

  try {
    const config = buildConfig({
      repoRoot: tmpRoot,
      env: {},
      homeEnvPath,
      configPath,
    });
    assert.equal(config.openAiApiKey, "test-openrouter-key");
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("buildConfig: benchmark config wins over home .env for non-secret settings", async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-config-env-"));
  const configPath = path.join(tmpRoot, "benchmarks", "benchmark.config.json");
  const homeEnvPath = path.join(tmpRoot, "home.env");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      modelProvider: "openai-compatible",
      model: "google/gemini-3-flash-preview",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
      maxContextTokens: 32000,
    }),
  );
  await writeFile(
    homeEnvPath,
    "MODEL=google/gemini-home\nOPENAI_BASE_URL=https://example.invalid/v1\nOPENROUTER_API_KEY=home-openrouter-key\n",
  );

  try {
    const config = buildConfig({
      repoRoot: tmpRoot,
      env: {},
      homeEnvPath,
      configPath,
    });
    assert.equal(config.modelProvider, "openai-compatible");
    assert.equal(config.model, "google/gemini-3-flash-preview");
    assert.equal(config.openAiBaseUrl, "https://openrouter.ai/api/v1");
    assert.equal(config.openAiApiKey, "home-openrouter-key");
    assert.equal(config.maxContextTokens, 32000);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("buildConfig: shell env overrides benchmark config and home env", async () => {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "bench-config-shell-env-"));
  const configPath = path.join(tmpRoot, "benchmarks", "benchmark.config.json");
  const homeEnvPath = path.join(tmpRoot, "home.env");
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      modelProvider: "openai-compatible",
      model: "google/gemini-3-flash-preview",
      openAiBaseUrl: "https://openrouter.ai/api/v1",
      maxContextTokens: 32000,
    }),
  );
  await writeFile(homeEnvPath, "OPENROUTER_API_KEY=home-openrouter-key\n");

  try {
    const config = buildConfig({
      repoRoot: tmpRoot,
      env: {
        MODEL_PROVIDER: "anthropic",
        MODEL: "claude-test",
        OPENAI_BASE_URL: "https://override.example/v1",
        MAX_CONTEXT_TOKENS: "64000",
      },
      homeEnvPath,
      configPath,
    });
    assert.equal(config.modelProvider, "anthropic");
    assert.equal(config.model, "claude-test");
    assert.equal(config.openAiBaseUrl, "https://override.example/v1");
    assert.equal(config.maxContextTokens, 64000);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("buildConfig: falls back to hardcoded defaults when config file is missing", () => {
  const config = buildConfig({
    repoRoot: "/tmp/bench-missing-config",
    env: {},
    homeEnvPath: "/tmp/bench-missing-home-env",
    configPath: "/tmp/bench-missing-config/benchmarks/missing.json",
  });
  assert.equal(config.modelProvider, "openai-compatible");
  assert.equal(config.model, "test-model");
  assert.equal(config.openAiBaseUrl, "http://localhost:1234/v1");
  assert.equal(config.maxSteps, 50);
});

// ─── loadTasks ────────────────────────────────────────────────────

let tmpDir: string;

async function setupTempTasks(): Promise<string> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "bench-cli-test-"));
  await mkdir(path.join(tmpDir, "navigation", "find-foo"), { recursive: true });
  await mkdir(path.join(tmpDir, "editing", "fix-bar"), { recursive: true });

  await writeFile(
    path.join(tmpDir, "navigation", "find-foo", "task.json"),
    JSON.stringify({
      title: "Find foo",
      prompt: "Find foo",
      rubric: { expectedOutputPatterns: ["foo"] },
    }),
  );
  await writeFile(
    path.join(tmpDir, "editing", "fix-bar", "task.json"),
    JSON.stringify({
      title: "Fix bar",
      prompt: "Fix bar",
      rubric: { expectedOutputPatterns: ["bar"] },
    }),
  );

  return tmpDir;
}

test("loadTasks: loads all tasks when no filter", async () => {
  const dir = await setupTempTasks();
  try {
    const tasks = await loadTasks(dir, { variant: "ci" });
    assert.equal(tasks.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTasks: filters by category", async () => {
  const dir = await setupTempTasks();
  try {
    const tasks = await loadTasks(dir, { variant: "ci", category: "navigation" });
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0]);
    assert.equal(tasks[0].category, "navigation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTasks: loads single task by id", async () => {
  const dir = await setupTempTasks();
  try {
    const tasks = await loadTasks(dir, { variant: "ci", task: "navigation/find-foo" });
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0]);
    assert.equal(tasks[0].id, "navigation/find-foo");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTasks: throws for unknown task id", async () => {
  const dir = await setupTempTasks();
  try {
    await assert.rejects(
      () => loadTasks(dir, { variant: "ci", task: "navigation/nonexistent" }),
      { message: "Task not found: navigation/nonexistent" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadTasks: throws for unknown category", async () => {
  const dir = await setupTempTasks();
  try {
    await assert.rejects(
      () => loadTasks(dir, { variant: "ci", category: "nonexistent" }),
      { message: "No tasks found for category: nonexistent" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
