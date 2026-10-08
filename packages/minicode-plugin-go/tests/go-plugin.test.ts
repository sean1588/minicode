import assert from "node:assert/strict";
import { test } from "node:test";
import { goPlugin } from "../src/index.js";

test("extracts Go declarations, receiver types, signatures, and documentation", () => {
  const source = `package demo
// Box stores a value.
type Box[T any] struct { Value T }
type Reader interface {
  // Read retrieves a value.
  Read() string
}
type Alias = Box[int]
const (
  First = iota
  Second
)
var Left, Right int
func (b *Box[T]) Get() T { return b.Value }
func (b Box[T]) hidden() {}
// Identity returns its argument.
func Identity[T any](x T) T { return x }
func Écho() {}
var _ = Identity[int](0)
`;
  const symbols = goPlugin.indexFile("box.go", source);
  assert.deepEqual(symbols.map((s) => [s.qualifiedName, s.kind]), [
    ["demo.Box", "class"], ["demo.Reader", "interface"], ["demo.Reader.Read", "method"],
    ["demo.Alias", "type"], ["demo.First", "variable"], ["demo.Second", "variable"],
    ["demo.Left", "variable"], ["demo.Right", "variable"], ["demo.Box.Get", "method"],
    ["demo.Box.hidden", "method"], ["demo.Identity", "function"], ["demo.Écho", "function"],
  ]);
  const box = symbols[0]!;
  assert.equal(box.signature, "type Box[T any] struct");
  assert.equal(box.docComment, "Box stores a value.");
  assert.equal(box.startLine, 3);
  assert.equal(box.endLine, 3);
  assert.equal(symbols[1]!.endLine, 7);
  assert.equal(symbols[2]!.docComment, "Read retrieves a value.");
  assert.equal(symbols[8]!.signature, "func (b *Box[T]) Get() T");
  assert.ok(symbols[8]!.aliases?.includes("Box.Get"));
  assert.equal(symbols[9]!.exported, false);
  assert.equal(symbols[10]!.docComment, "Identity returns its argument.");
  assert.equal(symbols[11]!.exported, true);
});

test("keeps package scope and ignores locals, comments, and string contents", () => {
  const symbols = goPlugin.indexFile("internal/demo.go", `package demo
/* Run is public. */
func Run() {
  type Local struct{}
  var local = "func Fake() {}"
  // func Comment() {}
}
`);
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0]!.qualifiedName, "internal/demo.Run");
  assert.equal(symbols[0]!.docComment, "Run is public.");
  assert.equal(symbols[0]!.endLine, 7);
  assert.equal(goPlugin.canIndex("sample.GO"), true);
  assert.equal(goPlugin.canIndex("go.mod"), false);
  assert.deepEqual(goPlugin.indexFile("empty.go", ""), []);
  assert.doesNotThrow(() => goPlugin.indexFile("broken.go", "package demo\nfunc Broken( {"));
});

test("supports grouped types and variables without leaking local declarations", () => {
  const symbols = goPlugin.indexFile("types.go", `package demo
type (
  // ID identifies a record.
  ID int
  Name = string
)
var (
  Ready = true
  Count int
)
`);
  assert.deepEqual(symbols.map((s) => s.name), ["ID", "Name", "Ready", "Count"]);
  assert.equal(symbols[0]!.signature, "type ID int");
  assert.equal(symbols[0]!.docComment, "ID identifies a record.");
});

test("variable initializers do not expose their local declarations as package symbols", () => {
  const symbols = goPlugin.indexFile("vars.go", `package demo
var Value = func() int { var local int; return local }()
var (
  Other = func() int { const nested = 1; return nested }()
)
`);
  assert.deepEqual(symbols.map((s) => s.name), ["Value", "Other"]);
});

test("type aliases and defined types reference their underlying named type", () => {
  const files = new Map([["types.go", "package demo\ntype Item struct{}\ntype Alias = Item\ntype Defined Item\n"]]);
  const symbols = goPlugin.indexFile("types.go", files.get("types.go")!);
  assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
    { from: "demo.Alias", to: "demo.Item", kind: "references" },
    { from: "demo.Defined", to: "demo.Item", kind: "references" },
  ]);
});

test("resolves same-package calls and type references across files, isolating other packages", () => {
  const files = new Map([
    ["model.go", "package demo\ntype Item struct{}\nfunc helper() {}\n"],
    ["run.go", "package demo\nfunc Run(x Item) { helper(); helper() }\n"],
    ["other/model.go", "package demo\nfunc helper() {}\n"],
    ["external_test.go", "package demo_test\nfunc Test() { helper() }\n"],
  ]);
  const symbols = [...files].flatMap(([file, text]) => goPlugin.indexFile(file, text));
  const edges = goPlugin.resolveDependencies(symbols, files);
  assert.deepEqual(edges, [
    { from: "demo.Run", to: "demo.helper", kind: "calls" },
    { from: "demo.Run", to: "demo.Item", kind: "references" },
  ]);
});

test("does not invent edges for shadowed names, external selectors, or ambiguous declarations", () => {
  const files = new Map([
    ["helpers.go", "package demo\nfunc helper() {}\nfunc duplicated() {}\n"],
    ["alternative.go", "package demo\nfunc duplicated() {}\n"],
    ["run.go", `package demo
import external "example.org/external"
func Parameter(helper func()) { helper() }
func Local() { helper := func() {}; helper() }
func Selector() { external.helper(); duplicated() }
func Positive() { helper() }
`],
  ]);
  const symbols = [...files].flatMap(([file, text]) => goPlugin.indexFile(file, text));
  assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
    { from: "demo.Positive", to: "demo.helper", kind: "calls" },
  ]);
});

const docCases: [string, string, string | undefined][] = [
  ["line group", "// F does work.\n// More detail.\nfunc F() {}", "F does work.\nMore detail."],
  ["blank line", "// unrelated\n\nfunc F() {}", undefined],
  ["previous trailing comment", "var x = 1 // unrelated\nfunc F() {}", undefined],
  ["directives", "// F does work.\n//go:noinline\n//go:generate tool\nfunc F() {}", "F does work."],
  ["directive only", "//go:noinline\nfunc F() {}", undefined],
  ["block comment", "/*\n * F does work.\n * More detail.\n */\nfunc F() {}", "F does work.\nMore detail."],
  ["group doc", "// Group documentation.\nconst (\n F = 1\n)", "Group documentation."],
  ["spec doc", "// Group documentation.\nconst (\n // F documentation.\n F = 1\n)", "F documentation."],
];
for (const [label, source, expected] of docCases) {
  test(`documentation: ${label}`, () => {
    const symbols = goPlugin.indexFile("docs.go", `package demo\n${source}\n`);
    assert.equal(symbols.find((s) => s.name === "F")?.docComment, expected);
  });
}

test("iota trailing comments never become the next constant's documentation", () => {
  const symbols = goPlugin.indexFile("enum.go", `package demo
const (
 KindA = iota // first
 KindB // second
 KindC // third
)
`);
  assert.equal(symbols.length, 3);
  assert.ok(symbols.every((s) => s.docComment === undefined));
});

test("generic receiver parameters shadow package types without hiding the receiver type", () => {
  const files = new Map([["box.go", `package demo
type T struct{}
type Box[V any] struct { Value V }
func (b *Box[T]) Get() T { return b.Value }
func (b Box[T]) Copy() T { return b.Value }
`]]);
  const symbols = goPlugin.indexFile("box.go", files.get("box.go")!);
  assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
    { from: "demo.Box.Get", to: "demo.Box", kind: "references" },
    { from: "demo.Box.Copy", to: "demo.Box", kind: "references" },
  ]);
});

const shadowCases = [
  "func Run(v func()) { v() }",
  "func Run(v ...func()) { v() }",
  "func Run() { v := func() {}; v() }",
  "func Run() { var v func(); v() }",
  "func Run() { const v = 1; _ = v }",
  "func Run() { type v int; var x v; _ = x }",
  "func Run() { type v = int; var x v; _ = x }",
  "func Run[v any](x v) {}",
  "func Run(xs []func()) { for _, v := range xs { v() } }",
  "func Run(x any) { switch v := x.(type) { case func(): v() } }",
  "func Run(ch chan func()) { select { case v := <-ch: v() } }",
  // Whole-declaration suppression intentionally includes names in nested closures.
  "func Run() { v(); func() { v := 1; _ = v }() }",
];
for (const source of shadowCases) {
  test(`shadowing: ${source}`, () => {
    const files = new Map([["shadow.go", `package demo\nfunc v() {}\n${source}\nfunc Positive() { v() }\n`]]);
    const symbols = goPlugin.indexFile("shadow.go", files.get("shadow.go")!);
    assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
      { from: "demo.Positive", to: "demo.v", kind: "calls" },
    ]);
  });
}

test("methods do not compete with bare functions, and self references are omitted", () => {
  const files = new Map([["file.go", `package demo
type File struct{}
func (f *File) Close() {}
func Close() { Close() }
func Run() { Close() }
type Node struct { next *Node }
`]]);
  const symbols = goPlugin.indexFile("file.go", files.get("file.go")!);
  assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
    { from: "demo.File.Close", to: "demo.File", kind: "references" },
    { from: "demo.Run", to: "demo.Close", kind: "calls" },
  ]);
});

test("dot imports suppress resolution only in the importing file", () => {
  const files = new Map([
    ["dot.go", 'package demo\nimport . "external"\nfunc Run() { Helper() }\n'],
    ["helper.go", "package demo\nfunc Helper() {}\nfunc Positive() { Helper() }\n"],
  ]);
  const symbols = [...files].flatMap(([file, text]) => goPlugin.indexFile(file, text));
  assert.deepEqual(goPlugin.resolveDependencies(symbols, files), [
    { from: "demo.Positive", to: "demo.Helper", kind: "calls" },
  ]);
});

test("variable signatures stay compact while source ranges retain the initializer", () => {
  const symbols = goPlugin.indexFile("table.go", `package demo
var Table = []struct{ Name string }{
 {"one"},
 {"two"},
}
`);
  assert.equal(symbols[0]!.signature, "var Table = []struct{ Name string }{");
  assert.equal(symbols[0]!.endLine, 5);
});

test("Go-specific excluded path segments work on POSIX and Windows paths", () => {
  for (const file of ["vendor/a.go", "pkg/testdata/a.go", "_scratch/a.go", "pkg/_scratch/a.go", "_ignored.go"]) {
    assert.equal(goPlugin.canIndex(file), false, file);
    assert.equal(goPlugin.canIndex(file.replaceAll("/", "\\")), false, file);
  }
  for (const file of ["main.go", "pkg/foo_test.go", "pkg/vendorish/a.go", "pkg/has_underscore/a.go"]) {
    assert.equal(goPlugin.canIndex(file), true, file);
  }
});
