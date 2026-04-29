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

test("Python plugin includes decorators in signatures", () => {
  const code = [
    "@dataclass(frozen=True)",
    "class Foo:",
    "    pass",
    "",
    "@property",
    "def value() -> int:",
    "    return 1",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  const foo = symbols.find((s) => s.name === "Foo");
  const value = symbols.find((s) => s.name === "value");
  assert.ok(foo);
  assert.ok(value);
  assert.ok(
    foo!.signature.includes("@dataclass(frozen=True)"),
    `expected @dataclass in signature, got ${foo!.signature}`,
  );
  assert.ok(
    value!.signature.startsWith("@property"),
    `expected @property in signature, got ${value!.signature}`,
  );
});

test("Python plugin honors __all__ for top-level exported flag", () => {
  const code = [
    "__all__ = ['public_helper', '_private_but_listed']",
    "",
    "def public_helper():",
    "    pass",
    "",
    "def not_listed():",
    "    pass",
    "",
    "def _private_but_listed():",
    "    pass",
    "",
    "def _private():",
    "    pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  const get = (name: string) =>
    symbols.find((s) => s.name === name) ?? assert.fail(`missing ${name}`);
  assert.equal(get("public_helper").exported, true);
  assert.equal(get("not_listed").exported, false, "not in __all__ → not exported");
  assert.equal(
    get("_private_but_listed").exported,
    true,
    "underscored but in __all__ → exported",
  );
  assert.equal(get("_private").exported, false);
});

test("Python plugin marks Protocol classes as interfaces", () => {
  const code = [
    "from typing import Protocol",
    "",
    "class Animal(Protocol):",
    "    def speak(self) -> str: ...",
    "",
    "class GenericIface(Protocol[int]):",
    "    pass",
    "",
    "import typing",
    "class QualifiedIface(typing.Protocol):",
    "    pass",
    "",
    "class Plain:",
    "    pass",
    "",
  ].join("\n");
  const symbols = pythonPlugin.indexFile("sample.py", code);
  assert.equal(symbols.find((s) => s.name === "Animal")!.kind, "interface");
  assert.equal(symbols.find((s) => s.name === "GenericIface")!.kind, "interface");
  assert.equal(symbols.find((s) => s.name === "QualifiedIface")!.kind, "interface");
  assert.equal(symbols.find((s) => s.name === "Plain")!.kind, "class");
});

test("Python plugin Protocol→interface still receives extends edges as base class", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-proto-"));
  await writeFile(
    path.join(workspaceRoot, "iface.py"),
    [
      "from typing import Protocol",
      "",
      "class Animal(Protocol):",
      "    def speak(self) -> str: ...",
      "",
      "class Dog(Animal):",
      "    def speak(self) -> str:",
      "        return 'woof'",
      "",
    ].join("\n"),
    "utf8",
  );
  const index = await buildProjectIndex(workspaceRoot);
  const extendsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "extends" && e.from === "Dog",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "Animal"),
    "Dog should extend Animal even though Animal is an interface",
  );
});

test("buildProjectIndex handles a mixed TypeScript + Python workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-mixed-"));
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true });

  // TypeScript side
  await writeFile(
    path.join(workspaceRoot, "src", "types.ts"),
    "export interface Greeter {\n  greet(name: string): string;\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "src", "service.ts"),
    [
      "import type { Greeter } from \"./types.js\";",
      "",
      "export class Service implements Greeter {",
      "  greet(name: string): string {",
      "    return `Hello ${name}`;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  // Python side
  await writeFile(
    path.join(workspaceRoot, "src", "models.py"),
    [
      "from dataclasses import dataclass",
      "",
      "@dataclass",
      "class User:",
      "    name: str",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "src", "service.py"),
    [
      "from .models import User",
      "",
      "def make_user(name: str) -> User:",
      "    return User(name=name)",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);

  // TypeScript symbols
  const greeter = index.getSymbol("Greeter");
  const tsService = index.getSymbol("Service");
  assert.ok(greeter, "TypeScript interface Greeter should be indexed");
  assert.equal(greeter!.kind, "interface");
  assert.ok(tsService, "TypeScript class Service should be indexed");
  assert.equal(tsService!.kind, "class");

  // Python symbols
  const user = index.getSymbol("User");
  const makeUser = index.getSymbol("make_user");
  assert.ok(user, "Python User dataclass should be indexed");
  assert.equal(user!.filePath, "src/models.py");
  assert.ok(makeUser, "Python make_user function should be indexed");
  assert.equal(makeUser!.filePath, "src/service.py");

  // Edges from BOTH plugins should land in the same graph
  const tsImpl = index.dependencyEdges.find(
    (e) => e.kind === "implements" && e.from === "Service" && e.to === "Greeter",
  );
  assert.ok(tsImpl, "TypeScript Service implements Greeter edge");

  const pyCall = index.dependencyEdges.find(
    (e) => e.kind === "calls" && e.from === "make_user" && e.to === "User",
  );
  assert.ok(pyCall, "Python make_user calls User edge");
});

test("Python plugin indexes .pyi stub files", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-pyi-"));
  await writeFile(
    path.join(workspaceRoot, "stubs.pyi"),
    [
      "from typing import Protocol",
      "",
      "def loaded(name: str) -> bool: ...",
      "",
      "class Service(Protocol):",
      "    def run(self, task: str) -> int: ...",
      "    async def shutdown(self) -> None: ...",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);

  const loaded = index.getSymbol("loaded");
  assert.ok(loaded, "stub-file function should be indexed");
  assert.equal(loaded!.kind, "function");
  assert.equal(loaded!.filePath, "stubs.pyi");
  assert.ok(
    loaded!.signature.startsWith("def loaded"),
    `expected stub function signature, got ${loaded!.signature}`,
  );

  const service = index.getSymbol("Service");
  assert.ok(service, "stub-file Protocol class should be indexed");
  assert.equal(service!.kind, "interface");

  const run = index.getSymbol("Service.run");
  const shutdown = index.getSymbol("Service.shutdown");
  assert.ok(run, "stub-file method run should be indexed");
  assert.equal(run!.kind, "method");
  assert.ok(shutdown, "stub-file async method shutdown should be indexed");
  assert.ok(
    shutdown!.signature.startsWith("async def shutdown"),
    `expected async stub signature, got ${shutdown!.signature}`,
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
