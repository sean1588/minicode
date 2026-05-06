import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEditFileTool } from "../src/tools/edit-file.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createSearchTool } from "../src/tools/search.js";
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
    afterEdit: (path) => {
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

test("search finds matches inside hidden files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await mkdir(path.join(workspaceRoot, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(workspaceRoot, ".github", "workflows", "ci.yml"), "name: CI\nsteps:\n  - run: echo hello\n", "utf8");

  const searchTool = createSearchTool(createTestAgentConfig(workspaceRoot));
  const result = await searchTool.execute({ pattern: "echo hello" });

  assert.ok(result.includes(".github/workflows/ci.yml"));
});

test("search finds matches inside gitignored files", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, ".gitignore"), "generated.txt\n", "utf8");
  await writeFile(path.join(workspaceRoot, "generated.txt"), "needle in ignored file\n", "utf8");

  const searchTool = createSearchTool(createTestAgentConfig(workspaceRoot));
  const result = await searchTool.execute({ pattern: "needle in ignored file" });

  assert.ok(result.includes("generated.txt"));
});


// ─── Honest tool outputs (closes #176) ────────────────────────

test("read_file emits a footer when content is clipped by an explicit limit", async () => {
  const workspaceRoot = await createTempWorkspace();
  const lines = Array.from({ length: 462 }, (_, i) => `line ${i + 1}`);
  await writeFile(path.join(workspaceRoot, "big.txt"), lines.join("\n"), "utf8");

  const readTool = createReadFileTool(createTestAgentConfig(workspaceRoot));
  const result = await readTool.execute({ path: "big.txt", limit: 260 });

  // The agent must know it didn't see the full file. Without this,
  // it confidently says "the symbol on line 462 doesn't exist."
  assert.match(result, /showed lines 1-260 of 462/);
  assert.match(result, /202 more line\(s\)/);
});

test("read_file emits no footer when the requested range covers the file", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "small.txt"), "a\nb\nc\nd", "utf8");

  const readTool = createReadFileTool(createTestAgentConfig(workspaceRoot));
  const result = await readTool.execute({ path: "small.txt", limit: 10 });

  assert.doesNotMatch(result, /more line/);
  assert.doesNotMatch(result, /showed lines/);
});

test("read_file emits a footer when offset+limit covers only middle of file", async () => {
  const workspaceRoot = await createTempWorkspace();
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  await writeFile(path.join(workspaceRoot, "mid.txt"), lines.join("\n"), "utf8");

  const readTool = createReadFileTool(createTestAgentConfig(workspaceRoot));
  const result = await readTool.execute({
    path: "mid.txt",
    offset: 40,
    limit: 20,
  });

  assert.match(result, /showed lines 40-59 of 100/);
  assert.match(result, /41 more line\(s\)/);
});

test("search 'no matches' annotates the search domain and exclusions", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "a.txt"), "hello world\n", "utf8");

  const searchTool = createSearchTool(createTestAgentConfig(workspaceRoot));
  const result = await searchTool.execute({ pattern: "definitely-not-there" });

  // Without these breadcrumbs the agent can't tell "the pattern truly
  // isn't there" from "the search was filtered or scoped wrong."
  assert.match(result, /No matches for/);
  assert.match(result, /definitely-not-there/);
  assert.match(result, /Excluded/);
  assert.match(result, /node_modules/);
  assert.match(result, /search_code_map|read_file/);
});

test("search 'no matches' surfaces include glob in the domain footer", async () => {
  const workspaceRoot = await createTempWorkspace();
  await writeFile(path.join(workspaceRoot, "a.ts"), "hello\n", "utf8");

  const searchTool = createSearchTool(createTestAgentConfig(workspaceRoot));
  const result = await searchTool.execute({
    pattern: "definitely-not-there",
    include: "*.md",
  });

  assert.match(result, /matching glob "\*\.md"/);
});
