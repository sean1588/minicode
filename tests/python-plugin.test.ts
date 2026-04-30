import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getPluginForFile, loadPlugins } from "../src/indexer/plugin-loader.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";

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

  // Module-prefixed qualifiedNames (src/ stripped). Processor lives in
  // `src/processor.py` → module `processor`; TaskRunner in `src/types.py`.
  const extendsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "extends" && e.from === "processor.Processor",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "types.TaskRunner"),
    "processor.Processor should extend types.TaskRunner",
  );

  const callEdges = index.dependencyEdges.filter((e) => e.kind === "calls");
  assert.ok(
    callEdges.some(
      (e) => e.from === "parser.parse_and_process" && e.to === "parser.parse",
    ),
    "parser.parse_and_process should call parser.parse",
  );
  assert.ok(
    callEdges.some(
      (e) => e.from === "parser.parse_and_process" && e.to === "parser.process",
    ),
    "parser.parse_and_process should call parser.process",
  );
  assert.ok(
    callEdges.some(
      (e) =>
        e.from === "processor.Processor.run" &&
        e.to === "parser.parse_and_process",
    ),
    "processor.Processor.run should call parser.parse_and_process across files",
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
    (e) => e.kind === "extends" && e.from === "pkg.sub.Sub",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "pkg.base.Base"),
    "pkg.sub.Sub should extend pkg.base.Base via relative import",
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
    (e) => e.kind === "calls" && e.from === "mod.Foo.run",
  );
  assert.ok(
    edges.some((e) => e.to === "mod.Foo.helper"),
    "mod.Foo.run should call mod.Foo.helper via self",
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
  // `lib/` is a stripped source root, so `lib/util.py` → module `util`.
  // `main.py` is at the workspace root → module `main`.
  const edges = index.dependencyEdges.filter(
    (e) => e.kind === "calls" && e.from === "main.run",
  );
  assert.ok(
    edges.some((e) => e.to === "util.helper"),
    "main.run should call util.helper imported from the lib/ source root",
  );
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
    (e) => e.kind === "extends" && e.from === "iface.Dog",
  );
  assert.ok(
    extendsEdges.some((e) => e.to === "iface.Animal"),
    "iface.Dog should extend iface.Animal even though Animal is an interface",
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

  const greeter = index.getSymbol("Greeter");
  const tsService = index.getSymbol("Service");
  assert.ok(greeter, "TypeScript interface Greeter should be indexed");
  assert.equal(greeter!.kind, "interface");
  assert.ok(tsService, "TypeScript class Service should be indexed");
  assert.equal(tsService!.kind, "class");

  const user = index.getSymbol("User");
  const makeUser = index.getSymbol("make_user");
  assert.ok(user, "Python User dataclass should be indexed");
  assert.equal(user!.filePath, "src/models.py");
  assert.ok(makeUser, "Python make_user function should be indexed");
  assert.equal(makeUser!.filePath, "src/service.py");

  // TS plugin still uses bare qualifiedNames; Python plugin now uses
  // module-prefixed qualifiedNames. Both kinds of edges coexist in the
  // same graph.
  const tsImpl = index.dependencyEdges.find(
    (e) => e.kind === "implements" && e.from === "Service" && e.to === "Greeter",
  );
  assert.ok(tsImpl, "TypeScript Service implements Greeter edge");

  const pyCall = index.dependencyEdges.find(
    (e) =>
      e.kind === "calls" &&
      e.from === "service.make_user" &&
      e.to === "models.User",
  );
  assert.ok(pyCall, "Python service.make_user calls models.User edge");
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

test("Python plugin module-qualified calls do not pollute edges with same-named symbols in other modules", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-modcall-"));
  await writeFile(
    path.join(workspaceRoot, "helpers.py"),
    "def parse():\n    return 1\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "validator.py"),
    "def parse():\n    return 2\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "main.py"),
    [
      "import helpers",
      "",
      "def run():",
      "    return helpers.parse()",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);

  const callEdgesFromRun = index.dependencyEdges.filter(
    (e) => e.kind === "calls" && e.from === "main.run",
  );

  // The run function should only call parse from helpers.py, not from validator.py.
  const helpersParse = index.getSymbolsInFile("helpers.py").find((s) => s.name === "parse");
  const validatorParse = index.getSymbolsInFile("validator.py").find((s) => s.name === "parse");
  assert.ok(helpersParse && validatorParse);

  assert.ok(
    callEdgesFromRun.some((e) => e.to === helpersParse!.qualifiedName),
    "main.run should call helpers.parse",
  );
  assert.ok(
    !callEdgesFromRun.some((e) => e.to === validatorParse!.qualifiedName),
    "main.run should NOT call validator.parse — module-qualified calls must not fall back to global leaf matches",
  );
});

test("Python plugin attribute base classes resolve via alias, not bare leaf", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-attr-base-"));
  await mkdir(path.join(workspaceRoot, "pkg"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "pkg", "__init__.py"),
    "",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "pkg", "base.py"),
    "class Base:\n    pass\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "pkg", "other.py"),
    "class Base:\n    pass\n",
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "pkg", "sub.py"),
    [
      "from . import base",
      "",
      "class Sub(base.Base):",
      "    pass",
      "",
    ].join("\n"),
    "utf8",
  );

  const index = await buildProjectIndex(workspaceRoot);

  const baseInBaseFile = index.getSymbolsInFile("pkg/base.py").find((s) => s.name === "Base");
  const baseInOtherFile = index.getSymbolsInFile("pkg/other.py").find((s) => s.name === "Base");
  assert.ok(baseInBaseFile && baseInOtherFile);

  const extendsFromSub = index.dependencyEdges.filter(
    (e) => e.kind === "extends" && e.from === "pkg.sub.Sub",
  );
  assert.ok(
    extendsFromSub.some((e) => e.to === baseInBaseFile!.qualifiedName),
    "pkg.sub.Sub should extend pkg.base.Base via the `base` alias",
  );
  assert.ok(
    !extendsFromSub.some((e) => e.to === baseInOtherFile!.qualifiedName),
    "pkg.sub.Sub should NOT extend pkg.other.Base — attribute bases must use the alias target's module file, not the bare leaf",
  );
});

test("Python plugin: bare-name lookups still resolve module-prefixed symbols", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-py-bare-lookup-"));
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

  // Canonical module-prefixed lookup
  assert.ok(index.getSymbol("module.Foo"));
  assert.ok(index.getSymbol("module.Foo.bar"));
  assert.ok(index.getSymbol("module.baz"));

  // User-natural lookups must still work via aliases — the agent and humans
  // refer to symbols this way and shouldn't have to know the module path.
  const foo = index.getSymbol("Foo");
  const fooBar = index.getSymbol("Foo.bar");
  const baz = index.getSymbol("baz");
  assert.ok(foo, "bare class lookup should resolve");
  assert.ok(fooBar, "Class.method lookup should resolve via alias");
  assert.ok(baz, "bare function lookup should resolve");
  assert.equal(foo!.qualifiedName, "module.Foo");
  assert.equal(fooBar!.qualifiedName, "module.Foo.bar");
  assert.equal(baz!.qualifiedName, "module.baz");
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
