import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPluginForFile, loadPlugins } from "../src/indexer/plugin-loader.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import { pythonPlugin } from "../src/indexer/plugins/python.js";

const SAMPLE_PY = [
  "import os",
  "from typing import Protocol",
  "",
  "@dataclass",
  "class Animal:",
  '    """An animal."""',
  "    name: str",
  "",
  "    def __init__(self, name: str):",
  "        self.name = name",
  "",
  "    async def fetch(self, ball: int) -> bool:",
  "        return True",
  "",
  "class Dog(Animal):",
  "    def speak(self) -> str:",
  '        """Bark!"""',
  '        return "woof"',
  "",
  "",
  "def helper(x: int) -> str:",
  "    return str(x)",
  "",
  "_private = 1",
  "",
  "type Vec = list[float]",
  "",
].join("\n");

test("Python plugin extracts classes, methods, functions, type aliases", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const names = symbols.map((s) => s.qualifiedName);
  assert.ok(names.includes("Animal"), "should extract class Animal");
  assert.ok(names.includes("Animal.__init__"), "should extract method __init__");
  assert.ok(names.includes("Animal.fetch"), "should extract async method fetch");
  assert.ok(names.includes("Dog"), "should extract class Dog");
  assert.ok(names.includes("Dog.speak"), "should extract method Dog.speak");
  assert.ok(names.includes("helper"), "should extract top-level helper");
  assert.ok(names.includes("Vec"), "should extract PEP 695 type alias");
});

test("Python plugin marks async def in signature", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const fetch = symbols.find((s) => s.qualifiedName === "Animal.fetch");
  assert.ok(fetch);
  assert.ok(
    fetch!.signature.startsWith("async def fetch"),
    `expected async-def signature, got ${fetch!.signature}`,
  );
});

test("Python plugin extracts class-superclass header in signature", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const dog = symbols.find((s) => s.qualifiedName === "Dog");
  assert.ok(dog);
  assert.equal(dog!.signature, "class Dog(Animal)");
});

test("Python plugin extracts docstrings as docComment", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const animal = symbols.find((s) => s.qualifiedName === "Animal");
  const speak = symbols.find((s) => s.qualifiedName === "Dog.speak");
  assert.ok(animal);
  assert.ok(speak);
  assert.equal(animal!.docComment, "An animal.");
  assert.equal(speak!.docComment, "Bark!");
});

test("Python plugin treats leading-underscore names as not exported", () => {
  const code = [
    "def _internal():",
    "    pass",
    "",
    "def public():",
    "    pass",
    "",
    "def __dunder__():",
    "    pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  assert.equal(
    symbols.find((s) => s.name === "_internal")!.exported,
    false,
    "underscored names are private",
  );
  assert.equal(symbols.find((s) => s.name === "public")!.exported, true);
  assert.equal(
    symbols.find((s) => s.name === "__dunder__")!.exported,
    true,
    "dunders are exported",
  );
});

test("Python plugin uses outer range for decorated definitions (decorators included in startLine)", () => {
  const code = [
    "@dataclass",
    "@frozen",
    "class C:",
    "    pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  const c = symbols.find((s) => s.name === "C");
  assert.ok(c);
  assert.equal(c!.startLine, 1, "startLine should include decorators");
});

test("Python plugin handles nested classes with correct qualified names", () => {
  const code = [
    "class Outer:",
    "    class Inner:",
    "        def m(self):",
    "            pass",
    "    def o(self):",
    "        pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("nested.py", code);
  const names = symbols.map((s) => s.qualifiedName).sort();
  assert.deepEqual(names, ["Outer", "Outer.Inner", "Outer.Inner.m", "Outer.o"]);
});

test("Python plugin extracts PEP 695 type alias signature", () => {
  const code = "type Vec = list[float]\n";
  const symbols = pythonPlugin.indexFile("sample.py", code);
  const vec = symbols.find((s) => s.name === "Vec");
  assert.ok(vec);
  assert.equal(vec!.kind, "type");
  assert.equal(vec!.signature, "type Vec = list[float]");
});

test("Python plugin returns empty array for empty file", () => {
  const symbols = pythonPlugin.indexFile("empty.py", "");
  assert.equal(symbols.length, 0);
});

test("Python plugin handles malformed syntax without throwing", () => {
  const symbols = pythonPlugin.indexFile("bad.py", "def : broken\n");
  assert.ok(Array.isArray(symbols));
});

test("Python plugin skips module docstrings", () => {
  const code = [
    '"""Module docstring."""',
    "def f():",
    "    pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]!.name, "f");
});

test("Plugin loader returns the built-in Python plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  assert.ok(plugins.some((p) => p.name === "python"));
});

test("getPluginForFile routes .py files to Python plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  const plugin = getPluginForFile("module.py", plugins);
  assert.ok(plugin);
  assert.equal(plugin!.name, "python");
});

test("getPluginForFile routes .pyi stub files to Python plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  const plugin = getPluginForFile("module.pyi", plugins);
  assert.ok(plugin);
  assert.equal(plugin!.name, "python");
});

test("buildProjectIndex indexes a Python workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-index-"));
  await writeFile(
    path.join(workspaceRoot, "module.py"),
    [
      "class Foo:",
      "    def bar(self):",
      "        pass",
      "",
      "def baz():",
      "    pass",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  assert.ok(index.getSymbol("Foo"));
  assert.ok(index.getSymbol("Foo.bar"));
  assert.ok(index.getSymbol("baz"));

  const codeMap = index.getCodeMap();
  assert.ok(codeMap.text.includes("class Foo"));
  assert.ok(codeMap.text.includes("def bar"));
  assert.ok(codeMap.text.includes("def baz"));
});

test("verify-index-python fixture exercises the indexing pipeline", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const fixtureRoot = path.join(root, "test-programs", "verify-index-python");
  const index = await buildProjectIndex(fixtureRoot);

  assert.ok(index.getSymbol("Processor"), "Processor class");
  assert.ok(index.getSymbol("Processor.run"), "Processor.run method");
  assert.ok(index.getSymbol("parse"), "parse function");
  assert.ok(index.getSymbol("Task"), "Task dataclass");
  assert.ok(index.getSymbol("TaskRunner"), "TaskRunner protocol");
  assert.ok(index.getSymbol("parse_and_process"), "parse_and_process function");

  const codeMap = index.getCodeMap();
  assert.ok(codeMap.text.includes("Processor"));
  assert.ok(codeMap.text.includes("parse_and_process"));
});

test("verify-index-python fixture produces extends and calls edges", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const fixtureRoot = path.join(root, "test-programs", "verify-index-python");
  const index = await buildProjectIndex(fixtureRoot);

  const extendsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "extends" && e.from === "Processor",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "TaskRunner"),
    "Processor should extend TaskRunner",
  );

  const callEdges = index.dependencyEdges.filter((e) => e.kind === "calls");
  assert.ok(
    callEdges.some((e) => e.from === "parse_and_process" && e.to === "parse"),
    "parse_and_process should call parse",
  );
  assert.ok(
    callEdges.some((e) => e.from === "parse_and_process" && e.to === "process"),
    "parse_and_process should call process",
  );
  assert.ok(
    callEdges.some((e) => e.from === "Processor.run" && e.to === "parse_and_process"),
    "Processor.run should call parse_and_process across files",
  );
});

test("Python plugin extends edges resolve relative imports", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-extends-"));
  await mkdir(path.join(workspaceRoot, "pkg"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "pkg", "base.py"),
    "class Base:\n    pass\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "pkg", "sub.py"),
    "from .base import Base\n\nclass Sub(Base):\n    pass\n",
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  const extendsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "extends" && e.from === "Sub",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "Base"),
    "Sub should extend Base via relative import",
  );
});

test("Python plugin calls edges resolve self.method invocations", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-self-"));
  await writeFile(
    path.join(workspaceRoot, "mod.py"),
    [
      "class Foo:",
      "    def helper(self):",
      "        return 1",
      "",
      "    def run(self):",
      "        return self.helper()",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  const edges = index.dependencyEdges.filter(
    (e) => e.kind === "calls" && e.from === "Foo.run",
  );
  assert.ok(
    edges.some((e) => e.to === "Foo.helper"),
    "Foo.run should call Foo.helper via self",
  );
});

test("Python plugin calls edges resolve absolute imports", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-abs-"));
  await mkdir(path.join(workspaceRoot, "lib"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "lib", "util.py"),
    "def helper():\n    return 1\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "main.py"),
    [
      "from lib.util import helper",
      "",
      "def run():",
      "    return helper()",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  const edges = index.dependencyEdges.filter(
    (e) => e.kind === "calls" && e.from === "run",
  );
  assert.ok(
    edges.some((e) => e.to === "helper"),
    "run should call helper imported from lib.util",
  );
});

test("buildProjectIndex disambiguates colliding Python symbols across files", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-collide-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "src", "helpers.py"),
    "def parse():\n    return 1\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "src", "validator.py"),
    "def parse():\n    return 2\n",
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);
  const matches = index.getSymbolMatches("parse");
  assert.equal(matches.length, 2, "should keep both colliding symbols");
  const filePaths = matches.map((m) => m.filePath).sort();
  assert.deepEqual(filePaths, ["src/helpers.py", "src/validator.py"]);
});
