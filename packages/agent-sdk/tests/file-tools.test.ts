import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEditFileTool } from "../src/tools/edit-file.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createTestAgentConfig } from "./test-utils.js";

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "sdk-tests-"));
}

test("read_file reads file with line numbers", async () => {
  const workspaceRoot = await createTempWorkspace();
  const filePath = path.join(workspaceRoot, "test.txt");
  await writeFile(filePath, "line1\nline2\nline3", "utf8");

  const tool = createReadFileTool(createTestAgentConfig(workspaceRoot));
  const result = await tool.execute({ path: "test.txt" });

  assert.ok(result.includes("1|line1"));
  assert.ok(result.includes("2|line2"));
  assert.ok(result.includes("3|line3"));
});

test("read_file supports negative offset", async () => {
  const workspaceRoot = await createTempWorkspace();
  const filePath = path.join(workspaceRoot, "lines.txt");
  await writeFile(filePath, "a\nb\nc\nd", "utf8");

  const readTool = createReadFileTool(createTestAgentConfig(workspaceRoot));
  const output = await readTool.execute({
    path: "lines.txt",
    offset: -2,
    limit: 2,
  });

  assert.equal(output, "3|c\n4|d");
});

test("read_file rejects paths outside workspace", async () => {
  const workspaceRoot = await createTempWorkspace();
  const tool = createReadFileTool(createTestAgentConfig(workspaceRoot));

  await assert.rejects(
    () => tool.execute({ path: "../../../etc/passwd" }),
    /outside workspace root/,
  );
});

test("edit_file replaces exactly one match", async () => {
  const workspaceRoot = await createTempWorkspace();
  const filePath = path.join(workspaceRoot, "sample.txt");
  await writeFile(filePath, "hello world", "utf8");

  const editTool = createEditFileTool(createTestAgentConfig(workspaceRoot));
  const result = await editTool.execute({
    path: "sample.txt",
    old_string: "world",
    new_string: "there",
  });

  assert.match(result, /Updated "sample\.txt" successfully\./);
  const updated = await readFile(filePath, "utf8");
  assert.equal(updated, "hello there");
});

test("edit_file fails when old_string is not unique", async () => {
  const workspaceRoot = await createTempWorkspace();
  const filePath = path.join(workspaceRoot, "sample.txt");
  await writeFile(filePath, "repeat repeat repeat", "utf8");

  const editTool = createEditFileTool(createTestAgentConfig(workspaceRoot));
  await assert.rejects(
    () =>
      editTool.execute({
        path: "sample.txt",
        old_string: "repeat",
        new_string: "once",
      }),
    /matched 3 times/,
  );

  const unchanged = await readFile(filePath, "utf8");
  assert.equal(unchanged, "repeat repeat repeat");
});

test("edit_file calls afterEdit hook", async () => {
  const workspaceRoot = await createTempWorkspace();
  const filePath = path.join(workspaceRoot, "hook-test.txt");
  await writeFile(filePath, "before edit", "utf8");

  let hookCalled = false;
  let hookPath = "";
  const editTool = createEditFileTool(createTestAgentConfig(workspaceRoot), {
    afterEdit: (path, _content) => {
      hookCalled = true;
      hookPath = path;
    },
  });

  await editTool.execute({
    path: "hook-test.txt",
    old_string: "before",
    new_string: "after",
  });

  assert.ok(hookCalled);
  assert.ok(hookPath.endsWith("hook-test.txt"));
});

test("write_file creates file and calls afterWrite hook", async () => {
  const workspaceRoot = await createTempWorkspace();

  let hookCalled = false;
  const writeTool = createWriteFileTool(createTestAgentConfig(workspaceRoot), {
    afterWrite: () => {
      hookCalled = true;
    },
  });

  const result = await writeTool.execute({
    path: "new-file.txt",
    content: "hello world",
  });

  assert.match(result, /Wrote 11 characters/);
  const content = await readFile(path.join(workspaceRoot, "new-file.txt"), "utf8");
  assert.equal(content, "hello world");
  assert.ok(hookCalled);
});

test("write_file creates nested directories", async () => {
  const workspaceRoot = await createTempWorkspace();

  const writeTool = createWriteFileTool(createTestAgentConfig(workspaceRoot));
  await writeTool.execute({
    path: "deep/nested/dir/file.txt",
    content: "nested content",
  });

  const content = await readFile(
    path.join(workspaceRoot, "deep/nested/dir/file.txt"),
    "utf8",
  );
  assert.equal(content, "nested content");
});
