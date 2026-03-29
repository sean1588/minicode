import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { parseArgs, buildConfig, loadTasks } from "../scripts/run-benchmarks.js";

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

test("buildConfig: returns defaults when no env vars set", () => {
  const originalProvider = process.env.MODEL_PROVIDER;
  const originalModel = process.env.MODEL;
  delete process.env.MODEL_PROVIDER;
  delete process.env.MODEL;

  try {
    const config = buildConfig();
    assert.equal(config.modelProvider, "openai-compatible");
    assert.equal(config.model, "test-model");
    assert.equal(config.maxSteps, 50);
    assert.equal(config.maxTokens, 4096);
    assert.equal(config.maxContextTokens, 40000);
    assert.equal(config.confirmDestructive, false);
  } finally {
    if (originalProvider !== undefined) process.env.MODEL_PROVIDER = originalProvider;
    if (originalModel !== undefined) process.env.MODEL = originalModel;
  }
});

test("buildConfig: reads MODEL_PROVIDER and MODEL from env", () => {
  const originalProvider = process.env.MODEL_PROVIDER;
  const originalModel = process.env.MODEL;
  process.env.MODEL_PROVIDER = "anthropic";
  process.env.MODEL = "claude-test";

  try {
    const config = buildConfig();
    assert.equal(config.modelProvider, "anthropic");
    assert.equal(config.model, "claude-test");
  } finally {
    if (originalProvider !== undefined) {
      process.env.MODEL_PROVIDER = originalProvider;
    } else {
      delete process.env.MODEL_PROVIDER;
    }
    if (originalModel !== undefined) {
      process.env.MODEL = originalModel;
    } else {
      delete process.env.MODEL;
    }
  }
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
