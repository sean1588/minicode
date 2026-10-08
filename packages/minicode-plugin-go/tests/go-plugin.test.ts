import assert from "node:assert/strict";
import { test } from "node:test";
import { goPlugin } from "../src/index.js";

test("extracts Go declarations, receiver types, signatures, and documentation", async () => {
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
  const symbols = await goPlugin.indexFile("box.go", source);
  assert.deepEqual(symbols.map((s) => [s.qualifiedName, s.kind]), [
    ["demo.Box", "type"], ["demo.Reader", "interface"], ["demo.Reader.Read", "method"],
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

test("keeps package scope and ignores locals, comments, and string contents", async () => {
  const symbols = await goPlugin.indexFile("internal/demo.go", `package demo
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
  assert.deepEqual(await goPlugin.indexFile("empty.go", ""), []);
  assert.doesNotThrow(() => goPlugin.indexFile("broken.go", "package demo\nfunc Broken( {"));
});

test("supports grouped types and variables without leaking local declarations", async () => {
  const symbols = await goPlugin.indexFile("types.go", `package demo
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

test("variable initializers do not expose their local declarations as package symbols", async () => {
  const symbols = await goPlugin.indexFile("vars.go", `package demo
var Value = func() int { var local int; return local }()
var (
  Other = func() int { const nested = 1; return nested }()
)
`);
  assert.deepEqual(symbols.map((s) => s.name), ["Value", "Other"]);
});

test("type aliases and defined types reference their underlying named type", async () => {
  const files = new Map([["types.go", "package demo\ntype Item struct{}\ntype Alias = Item\ntype Defined Item\n"]]);
  const symbols = await goPlugin.indexFile("types.go", files.get("types.go")!);
  assert.deepEqual(await goPlugin.resolveDependencies!(symbols, files), [
    { from: "demo.Alias", to: "demo.Item", kind: "references" },
    { from: "demo.Defined", to: "demo.Item", kind: "references" },
  ]);
});

test("resolves same-package calls and type references across files, isolating other packages", async () => {
  const files = new Map([
    ["model.go", "package demo\ntype Item struct{}\nfunc helper() {}\n"],
    ["run.go", "package demo\nfunc Run(x Item) { helper(); helper() }\n"],
    ["other/model.go", "package demo\nfunc helper() {}\n"],
    ["external_test.go", "package demo_test\nfunc Test() { helper() }\n"],
  ]);
  const symbols = (await Promise.all([...files].map(([file, text]) => goPlugin.indexFile(file, text)))).flat();
  const edges = await goPlugin.resolveDependencies!(symbols, files);
  assert.deepEqual(edges, [
    { from: "demo.Run", to: "demo.helper", kind: "calls" },
    { from: "demo.Run", to: "demo.Item", kind: "references" },
  ]);
});

test("does not invent edges for shadowed names, external selectors, or ambiguous declarations", async () => {
  const files = new Map([
    ["helpers.go", "package demo\nfunc helper() {}\nfunc duplicated() {}\n"],
    ["alternative.go", "package demo\nfunc duplicated() {}\n"],
    ["run.go", `package demo
import external "example.org/external"
func Parameter(helper func()) { helper() }
func Local() { helper := func() {}; helper() }
func Selector() { external.helper(); duplicated() }
`],
  ]);
  const symbols = (await Promise.all([...files].map(([file, text]) => goPlugin.indexFile(file, text)))).flat();
  assert.deepEqual(await goPlugin.resolveDependencies!(symbols, files), []);
});
