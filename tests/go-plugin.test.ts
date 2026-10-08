import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { getPluginForFile, loadPlugins } from "../src/indexer/plugin-loader.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";

test("built-in Go is not loaded twice when also declared as an npm dependency", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-go-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { "minicode-plugin-go": "*" } }));
  const plugins = await loadPlugins(root);
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

for (const replacement of ["missing", "undefined"]) {
  test(`Go ${replacement} export leaves Python and TypeScript available`, () => {
    const loader = pathToFileURL(path.resolve(import.meta.dirname, "../src/indexer/plugin-loader.ts")).href;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'minicode-plugin-go') {
          if (${JSON.stringify(replacement)} === 'missing') throw new Error('test native dependency unavailable');
          return { url: 'data:text/javascript,export const goPlugin = undefined;', shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }});
      const { loadPlugins } = await import(${JSON.stringify(loader)});
      const plugins = await loadPlugins(${JSON.stringify(tmpdir())});
      console.log(JSON.stringify(plugins.map(p => p.name)));
    `], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.deepEqual(JSON.parse(output), ["typescript", "python"]);
  });
}

test("Go fixture and TypeScript coexist, structs nest methods, excluded paths stay out", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-go-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../test-programs/verify-index-go"), root, { recursive: true });
  await writeFile(path.join(root, "client.ts"), "export function Process() {}\n");
  for (const dir of ["vendor", "testdata", "_scratch"]) {
    await mkdir(path.join(root, dir));
    await writeFile(path.join(root, dir, "ignored.go"), "package ignored\nfunc Ignored() {}\n");
  }
  const index = await buildProjectIndex(root);
  assert.equal(index.getSymbolsInFile("client.ts")[0]?.name, "Process");
  assert.equal(index.getSymbol("tasks.Process")?.filePath, "run.go");
  assert.equal(index.getSymbol("tasks.Task")?.kind, "class");
  assert.ok(index.getSymbol("Task.Label"));
  assert.ok(!index.getSymbol("Ignored"));
  assert.ok(index.dependencyEdges.some((e) => e.from === "tasks.Process" && e.to === "tasks.Normalize"));
  const lines = index.getCodeMap(10000).text.split("\n");
  const struct = lines.find((line) => line.includes("tasks.Task") && line.includes("(class)"))!;
  const method = lines.find((line) => line.includes("tasks.Task.Label"))!;
  assert.ok(struct && method);
  assert.ok(method.search(/\S/) > struct.search(/\S/), "receiver method nests under its struct");
});

test("normalized build-tag alternatives keep distinct outgoing edges", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minicode-go-platform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "helper.go"), "package main\nfunc Helper() {}\n");
  for (const platform of ["linux", "windows"]) {
    await writeFile(path.join(root, `${platform}.go`), `//go:build ${platform}\n\npackage main\nfunc platform() { Helper() }\n`);
  }
  const index = await buildProjectIndex(root);
  const alternatives = index.getSymbolMatches("platform");
  assert.equal(alternatives.length, 2);
  assert.notEqual(alternatives[0]!.qualifiedName, alternatives[1]!.qualifiedName);
  assert.deepEqual(index.dependencyEdges.map((e) => e.from).sort(), alternatives.map((s) => s.qualifiedName).sort());
  assert.ok(index.dependencyEdges.every((e) => e.to === "main.Helper" && e.kind === "calls"));
});
