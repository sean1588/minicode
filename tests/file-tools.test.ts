import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEditFileTool } from "../src/tools/edit-file.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createTestAgentConfig } from "./test-utils.js";

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mini-coder-tests-"));
}

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

test("read_file supports negative offset and line limits", async () => {
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
