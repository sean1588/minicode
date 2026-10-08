import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getPluginForFile, loadPlugins } from "../src/indexer/plugin-loader.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";

test("built-in Go is not loaded twice when also declared as an npm dependency", async () => {
  const plugins = await loadPlugins(path.resolve(import.meta.dirname, ".."));
  assert.equal(plugins.filter((plugin) => plugin.name === "go").length, 1);
});

test("Go works in a workspace without package.json, including reindexing", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-go-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugins = await loadPlugins(root);
  assert.equal(getPluginForFile("main.go", plugins)?.name, "go");
  await writeFile(path.join(root, "main.go"), "package main\nfunc main() { Helper() }\n");
  await writeFile(path.join(root, "helper.go"), "package main\nfunc Helper() {}\n");
  const index = await buildProjectIndex(root);
  assert.equal(index.getSymbol("Helper")?.qualifiedName, "main.Helper");
  assert.ok(index.getCodeMap().text.includes("Helper"));
  assert.ok(index.getDependencyCone("main.main", 1).some((s) => s.name === "Helper"));
  assert.deepEqual(index.dependencyEdges, [{ from: "main.main", to: "main.Helper", kind: "calls" }]);
  await index.reindexFile("main.go", "package main\nfunc main() {}\n");
  assert.deepEqual(index.dependencyEdges, []);
});
