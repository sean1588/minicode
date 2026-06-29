import assert from "node:assert/strict";
import { test } from "node:test";

import { pythonPlugin } from "../src/index.js";

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

test("Python plugin flags package entry points", () => {
  assert.ok(pythonPlugin.isEntryPoint, "plugin should provide isEntryPoint");
  assert.equal(pythonPlugin.isEntryPoint!("pkg/__init__.py"), true);
  assert.equal(pythonPlugin.isEntryPoint!("pkg/__main__.py"), true);
  assert.equal(pythonPlugin.isEntryPoint!("__init__.py"), true);
  assert.equal(pythonPlugin.isEntryPoint!("pkg/helpers.py"), false);
  assert.equal(pythonPlugin.isEntryPoint!("pkg/main.py"), false);
});

test("Python plugin extracts classes, methods, functions, type aliases with module-prefixed qualifiedNames", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const names = symbols.map((s) => s.qualifiedName);
  assert.ok(names.includes("sample.Animal"));
  assert.ok(names.includes("sample.Animal.__init__"));
  assert.ok(names.includes("sample.Animal.fetch"));
  assert.ok(names.includes("sample.Dog"));
  assert.ok(names.includes("sample.Dog.speak"));
  assert.ok(names.includes("sample.helper"));
  assert.ok(names.includes("sample.Vec"));
});

test("Python plugin exposes un-prefixed Class.method form as an alias", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const fetch = symbols.find((s) => s.qualifiedName === "sample.Animal.fetch");
  assert.ok(fetch);
  // The agent-friendly `Class.method` form must remain a valid lookup key
  // so users (and the LLM) don't have to know the module path.
  assert.ok(
    (fetch!.aliases ?? []).includes("Animal.fetch"),
    "Animal.fetch should be in aliases",
  );
});

test("Python plugin marks async def in signature", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const fetch = symbols.find((s) => s.qualifiedName === "sample.Animal.fetch");
  assert.ok(fetch);
  assert.ok(
    fetch!.signature.startsWith("async def fetch"),
    `expected async-def signature, got ${fetch!.signature}`,
  );
});

test("Python plugin extracts class-superclass header in signature", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const dog = symbols.find((s) => s.qualifiedName === "sample.Dog");
  assert.ok(dog);
  assert.equal(dog!.signature, "class Dog(Animal)");
});

test("Python plugin extracts docstrings as docComment", () => {
  const symbols = pythonPlugin.indexFile("sample.py", SAMPLE_PY);
  const animal = symbols.find((s) => s.qualifiedName === "sample.Animal");
  const speak = symbols.find((s) => s.qualifiedName === "sample.Dog.speak");
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
  assert.equal(symbols.find((s) => s.name === "_internal")!.exported, false);
  assert.equal(symbols.find((s) => s.name === "public")!.exported, true);
  assert.equal(symbols.find((s) => s.name === "__dunder__")!.exported, true);
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
  assert.equal(c!.startLine, 1);
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
  assert.deepEqual(names, [
    "nested.Outer",
    "nested.Outer.Inner",
    "nested.Outer.Inner.m",
    "nested.Outer.o",
  ]);
  // The bare `Class.method` form is preserved as an alias so existing
  // user-facing lookups continue to work.
  const innerM = symbols.find((s) => s.qualifiedName === "nested.Outer.Inner.m");
  assert.ok(innerM);
  assert.ok((innerM!.aliases ?? []).includes("Outer.Inner.m"));
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
  assert.ok(foo!.signature.includes("@dataclass(frozen=True)"));
  assert.ok(value!.signature.startsWith("@property"));
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
  assert.equal(get("not_listed").exported, false);
  assert.equal(get("_private_but_listed").exported, true);
  assert.equal(get("_private").exported, false);
});

test("Python plugin strips src/ source-root prefix in qualifiedNames", () => {
  const symbols = pythonPlugin.indexFile(
    "src/parser.py",
    "def parse():\n    return 1\n",
  );
  const parse = symbols.find((s) => s.name === "parse");
  assert.ok(parse);
  assert.equal(
    parse!.qualifiedName,
    "parser.parse",
    "src/ should be stripped, leaving the file's basename as the module",
  );
});

test("Python plugin strips lib/ source-root prefix in qualifiedNames", () => {
  const symbols = pythonPlugin.indexFile(
    "lib/util.py",
    "def helper():\n    return 1\n",
  );
  const helper = symbols.find((s) => s.name === "helper");
  assert.ok(helper);
  assert.equal(helper!.qualifiedName, "util.helper");
});

test("Python plugin preserves nested package path under stripped source root", () => {
  const symbols = pythonPlugin.indexFile(
    "src/services/parser.py",
    "def parse():\n    return 1\n",
  );
  const parse = symbols.find((s) => s.name === "parse");
  assert.ok(parse);
  assert.equal(
    parse!.qualifiedName,
    "services.parser.parse",
    "src/ stripped, but nested directories remain as part of the module path",
  );
});

test("Python plugin handles __init__.py: top-level becomes the package name", () => {
  const symbols = pythonPlugin.indexFile(
    "src/foo/__init__.py",
    "def init_helper():\n    return 1\n",
  );
  const helper = symbols.find((s) => s.name === "init_helper");
  assert.ok(helper);
  assert.equal(
    helper!.qualifiedName,
    "foo.init_helper",
    "__init__.py is stripped from the path, leaving the package name",
  );
});

test("Python plugin handles __init__.py at the stripped root: no prefix", () => {
  const symbols = pythonPlugin.indexFile(
    "src/__init__.py",
    "def root_helper():\n    return 1\n",
  );
  const helper = symbols.find((s) => s.name === "root_helper");
  assert.ok(helper);
  // After stripping `src/` and `__init__`, nothing is left → no prefix.
  assert.equal(
    helper!.qualifiedName,
    "root_helper",
    "symbols at the stripped source root get no module prefix",
  );
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
