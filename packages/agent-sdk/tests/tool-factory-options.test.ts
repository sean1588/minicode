import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createEditFileTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchTool,
  createWriteFileTool,
  type EditFileToolOptions,
  type ListFilesToolOptions,
  type ReadFileToolOptions,
  type RunCommandToolOptions,
  type SearchToolOptions,
  type WriteFileToolOptions,
} from "../src/index.js";

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "tool-options-tests-"));
}

test("createReadFileTool accepts a narrow ReadFileToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "hi.txt"), "hi\n", "utf8");

  const opts: ReadFileToolOptions = {
    workspaceRoot,
    maxFileSizeBytes: 1_000,
  };
  const tool = createReadFileTool(opts);
  const result = await tool.execute({ path: "hi.txt" });
  assert.ok(result.includes("1|hi"));
});

test("createWriteFileTool accepts a narrow WriteFileToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  const opts: WriteFileToolOptions = { workspaceRoot };
  const tool = createWriteFileTool(opts);
  const result = await tool.execute({ path: "out.txt", content: "data" });
  assert.match(result, /Wrote 4 characters/);
});

test("createEditFileTool accepts a narrow EditFileToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "f.txt"), "alpha", "utf8");

  const opts: EditFileToolOptions = { workspaceRoot };
  const tool = createEditFileTool(opts);
  const result = await tool.execute({
    path: "f.txt",
    old_string: "alpha",
    new_string: "beta",
  });
  assert.match(result, /Updated/);
});

test("createListFilesTool accepts a narrow ListFilesToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "a.txt"), "x", "utf8");

  const opts: ListFilesToolOptions = { workspaceRoot };
  const tool = createListFilesTool(opts);
  const result = await tool.execute({});
  assert.ok(result.includes("a.txt"));
});

test("createSearchTool accepts a narrow SearchToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "src.txt"), "needle\n", "utf8");

  const opts: SearchToolOptions = {
    workspaceRoot,
    commandTimeoutMs: 5_000,
  };
  const tool = createSearchTool(opts);
  const result = await tool.execute({ pattern: "needle" });
  assert.ok(result.includes("needle"));
});

test("createRunCommandTool accepts a narrow RunCommandToolOptions object", async () => {
  const workspaceRoot = await createTempWorkspace();
  const opts: RunCommandToolOptions = {
    workspaceRoot,
    commandTimeoutMs: 5_000,
    commandDenylist: [],
    confirmDestructive: false,
  };
  const tool = createRunCommandTool(opts);
  const result = await tool.execute({ command: "echo hello" });
  assert.match(result, /exit_code: 0/);
  assert.match(result, /hello/);
});
