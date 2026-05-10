import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEditFileTool, createReadFileTool, createRunCommandTool, createWriteFileTool } from "@sean.holung/minicode-sdk";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import { createToolRegistry } from "../src/tools/registry.js";
import { createTestAgentConfig } from "./test-utils.js";

async function createTempWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "minicode-tests-"));
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
    /multiple matches/i,
  );

  const unchanged = await readFile(filePath, "utf8");
  assert.equal(unchanged, "repeat repeat repeat");
});

test("edit_file triggers reindex when projectIndex provided", async () => {
  const workspaceRoot = await createTempWorkspace();
  const { mkdir } = await import("node:fs/promises");
  const filePath = path.join(workspaceRoot, "src", "util.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  const initialContent = `export function add(a: number, b: number): number {
  return a + b;
}
`;
  await writeFile(filePath, initialContent, "utf8");

  const index = await buildProjectIndex(workspaceRoot);
  const before = index.getSymbol("add");
  assert.ok(before?.signature.includes("a: number, b: number"));

  const editTool = createEditFileTool(
    createTestAgentConfig(workspaceRoot),
    { afterEdit: (relPath, content) => index.reindexFile(relPath, content) },
  );
  await editTool.execute({
    path: "src/util.ts",
    old_string: "a: number, b: number",
    new_string: "a: number, b: number, c?: number",
  });

  const after = index.getSymbol("add");
  assert.ok(after?.signature.includes("c?: number"), "index should reflect edit");
});

test("write_file triggers reindex when projectIndex provided", async () => {
  const workspaceRoot = await createTempWorkspace();
  const index = await buildProjectIndex(workspaceRoot);

  const writeTool = createWriteFileTool(
    createTestAgentConfig(workspaceRoot),
    { afterWrite: (relPath, content) => index.reindexFile(relPath, content) },
  );

  await writeTool.execute({
    path: "src/util.ts",
    content: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  });

  const added = index.getSymbol("add");
  assert.ok(added?.signature.includes("a: number, b: number"), "index should reflect newly written file");
});

test("write_file succeeds even when post-write reindex fails", async () => {
  const workspaceRoot = await createTempWorkspace();
  const index = await buildProjectIndex(workspaceRoot);
  index.reindexFile = async () => {
    throw new Error("reindex failed");
  };

  const registry = createToolRegistry(createTestAgentConfig(workspaceRoot), index);

  const result = await registry.execute("write_file", {
    path: "src/util.ts",
    content: `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
  });

  assert.match(result, /Wrote \d+ characters to "src\/util\.ts"\./);
  const written = await readFile(path.join(workspaceRoot, "src", "util.ts"), "utf8");
  assert.match(written, /export function add/);
});

test("edit_file succeeds even when post-edit reindex fails", async () => {
  const workspaceRoot = await createTempWorkspace();
  const { mkdir } = await import("node:fs/promises");
  const filePath = path.join(workspaceRoot, "src", "util.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  index.reindexFile = async () => {
    throw new Error("reindex failed");
  };

  const registry = createToolRegistry(createTestAgentConfig(workspaceRoot), index);

  const result = await registry.execute("edit_file", {
    path: "src/util.ts",
    old_string: "return a + b;",
    new_string: "return a + b + 1;",
  });

  assert.match(result, /Updated "src\/util\.ts" successfully\./);
  const updated = await readFile(filePath, "utf8");
  assert.match(updated, /return a \+ b \+ 1;/);
});

test("run_command refreshes index after shell-created file changes", async () => {
  const workspaceRoot = await createTempWorkspace();
  const index = await buildProjectIndex(workspaceRoot);

  const runTool = createRunCommandTool(
    createTestAgentConfig(workspaceRoot),
    { afterCommand: async () => index.refreshFromWorkspace() },
  );

  await runTool.execute({
    command: "mkdir -p src && cat <<'EOF' > src/util.ts\nexport function add(a: number, b: number): number {\n  return a + b;\n}\nEOF",
  });

  const added = index.getSymbol("add");
  assert.ok(added?.signature.includes("a: number, b: number"), "index should reflect shell-created file");
});

test("run_command refresh removes deleted files from the index", async () => {
  const workspaceRoot = await createTempWorkspace();
  const { mkdir } = await import("node:fs/promises");
  const filePath = path.join(workspaceRoot, "src", "util.ts");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `export function add(a: number, b: number): number {\n  return a + b;\n}\n`,
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  assert.ok(index.getSymbol("add"));

  const runTool = createRunCommandTool(
    createTestAgentConfig(workspaceRoot),
    { afterCommand: async () => index.refreshFromWorkspace() },
  );

  await runTool.execute({ command: "rm src/util.ts" });

  assert.equal(index.getSymbol("add"), undefined, "deleted file should be removed from the index");
});

test("run_command times out commands that ignore SIGTERM", async () => {
  const workspaceRoot = await createTempWorkspace();
  const config = createTestAgentConfig(workspaceRoot);
  config.commandTimeoutMs = 100;
  const runTool = createRunCommandTool(config);
  const start = Date.now();

  const output = await runTool.execute({
    command: `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`,
  });

  assert.match(output, /timed_out: true/);
  assert.ok(
    Date.now() - start < 5_000,
    "run_command should return after the timeout and kill grace period",
  );
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
