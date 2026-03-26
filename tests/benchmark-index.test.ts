import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";
import type { ProjectIndex } from "../src/indexer/types.js";

const FIXTURE_ROOT = path.resolve(
  import.meta.dirname,
  "..",
  "test-programs",
  "benchmark-index",
);

let index: ProjectIndex;

// Build the index once, reuse across tests
test("benchmark fixture: build index", async () => {
  index = await buildProjectIndex(FIXTURE_ROOT);
  assert.ok(index.symbols.size > 0, "should index symbols");
  assert.ok(index.files.size > 0, "should index files");
  assert.ok(index.dependencyEdges.length > 0, "should produce dependency edges");
});

// ---------------------------------------------------------------------------
// Symbol extraction
// ---------------------------------------------------------------------------

test("benchmark: indexes TypeScript class declarations", () => {
  const app = index.getSymbol("App");
  assert.ok(app, "should index App class");
  assert.equal(app!.kind, "class");
  assert.equal(app!.exported, true);

  assert.ok(index.getSymbol("App.start"), "should index App.start method");
  assert.ok(index.getSymbol("App.constructor"), "should index App constructor");
});

test("benchmark: indexes JS named class expressions (const X = class X {})", () => {
  const logger = index.getSymbol("ConsoleLogger");
  assert.ok(logger, "should index ConsoleLogger class expression");
  assert.equal(logger!.kind, "class");

  assert.ok(index.getSymbol("ConsoleLogger.info"), "should index ConsoleLogger.info");
  assert.ok(index.getSymbol("ConsoleLogger.error"), "should index ConsoleLogger.error");
  assert.ok(index.getSymbol("ConsoleLogger.constructor"), "should index constructor");
});

test("benchmark: indexes JS anonymous class expressions (const X = class {})", () => {
  const bus = index.getSymbol("EventBus");
  assert.ok(bus, "should index EventBus anonymous class expression");
  assert.equal(bus!.kind, "class");

  assert.ok(index.getSymbol("EventBus.on"), "should index EventBus.on");
  assert.ok(index.getSymbol("EventBus.emit"), "should index EventBus.emit");
  assert.ok(index.getSymbol("EventBus.constructor"), "should index EventBus constructor");
});

test("benchmark: indexes JS class declarations with inheritance", () => {
  const base = index.getSymbol("BasePlugin");
  assert.ok(base, "should index BasePlugin");
  assert.equal(base!.kind, "class");

  const auth = index.getSymbol("AuthPlugin");
  assert.ok(auth, "should index AuthPlugin");
  assert.equal(auth!.kind, "class");

  assert.ok(index.getSymbol("AuthPlugin.setupAuth"), "should index AuthPlugin.setupAuth");
});

test("benchmark: indexes interfaces and type aliases", () => {
  const logger = index.getSymbol("Logger");
  assert.ok(logger, "should index Logger interface");
  assert.equal(logger!.kind, "interface");

  const plugin = index.getSymbol("Plugin");
  assert.ok(plugin, "should index Plugin interface");
  assert.equal(plugin!.kind, "interface");

  const startable = index.getSymbol("Startable");
  assert.ok(startable, "should index Startable interface");

  const logLevel = index.getSymbol("LogLevel");
  assert.ok(logLevel, "should index LogLevel type alias");
  assert.equal(logLevel!.kind, "type");

  const handler = index.getSymbol("EventHandler");
  assert.ok(handler, "should index EventHandler type alias");
  assert.equal(handler!.kind, "type");
});

test("benchmark: indexes arrow functions and function expressions", () => {
  const fmt = index.getSymbol("formatMessage");
  assert.ok(fmt, "should index arrow function formatMessage");
  assert.equal(fmt!.kind, "function");

  const parse = index.getSymbol("parseEvent");
  assert.ok(parse, "should index function expression parseEvent");
  assert.equal(parse!.kind, "function");

  const handler = index.getSymbol("createHandler");
  assert.ok(handler, "should index function declaration createHandler");
  assert.equal(handler!.kind, "function");
});

test("benchmark: indexes function declarations in JS", () => {
  const create = index.getSymbol("createLogger");
  assert.ok(create, "should index createLogger");
  assert.equal(create!.kind, "function");
  assert.equal(create!.exported, true);

  const factory = index.getSymbol("createPlugin");
  assert.ok(factory, "should index createPlugin");
  assert.equal(factory!.kind, "function");
});

test("benchmark: indexes entry point function", () => {
  const main = index.getSymbol("main");
  assert.ok(main, "should index main");
  assert.equal(main!.kind, "function");
  assert.equal(main!.exported, true);
});

// ---------------------------------------------------------------------------
// Dependency edges
// ---------------------------------------------------------------------------

function hasEdge(
  from: string,
  to: string,
  kind: string,
): boolean {
  return index.dependencyEdges.some(
    (e) => e.from === from && e.to === to && e.kind === kind,
  );
}

test("benchmark: extends edges", () => {
  assert.ok(
    hasEdge("AuthPlugin", "BasePlugin", "extends"),
    "AuthPlugin should extend BasePlugin",
  );
});

test("benchmark: implements edges", () => {
  assert.ok(
    hasEdge("App", "Startable", "implements"),
    "App should implement Startable",
  );
});

test("benchmark: new expression call edges", () => {
  assert.ok(
    hasEdge("main", "App", "calls"),
    "main should call new App()",
  );
  assert.ok(
    hasEdge("App.start", "AuthPlugin", "calls"),
    "App.start should call new AuthPlugin()",
  );
  assert.ok(
    hasEdge("createLogger", "ConsoleLogger", "calls"),
    "createLogger should call new ConsoleLogger()",
  );
  assert.ok(
    hasEdge("createPlugin", "AuthPlugin", "calls"),
    "createPlugin should call new AuthPlugin()",
  );
  assert.ok(
    hasEdge("createPlugin", "BasePlugin", "calls"),
    "createPlugin should call new BasePlugin()",
  );
});

test("benchmark: function call edges", () => {
  assert.ok(
    hasEdge("main", "createLogger", "calls"),
    "main should call createLogger()",
  );
  assert.ok(
    hasEdge("createHandler", "formatMessage", "calls"),
    "createHandler should call formatMessage()",
  );
});

test("benchmark: type reference edges", () => {
  assert.ok(
    hasEdge("App.constructor", "Logger", "references"),
    "App.constructor should reference Logger type",
  );
  assert.ok(
    hasEdge("App.start", "AuthPlugin", "calls"),
    "App.start should call new AuthPlugin()",
  );
  assert.ok(
    hasEdge("createHandler", "EventHandler", "references"),
    "createHandler should reference EventHandler type",
  );
});

// ---------------------------------------------------------------------------
// Dependency cone traversal
// ---------------------------------------------------------------------------

test("benchmark: getDependencyCone from main", () => {
  const cone = index.getDependencyCone("main", 2);
  const names = cone.map((s) => s.qualifiedName);

  assert.ok(names.includes("main"), "cone should include main itself");
  assert.ok(names.includes("createLogger"), "depth 1: main calls createLogger");
  assert.ok(names.includes("App"), "depth 1: main calls new App");
  assert.ok(
    names.includes("ConsoleLogger"),
    "depth 2: createLogger calls new ConsoleLogger",
  );
});

test("benchmark: getDependencyCone from App.start", () => {
  const cone = index.getDependencyCone("App.start", 1);
  const names = cone.map((s) => s.qualifiedName);

  assert.ok(names.includes("App.start"), "cone should include App.start itself");
  assert.ok(names.includes("AuthPlugin"), "App.start calls new AuthPlugin");
});

// ---------------------------------------------------------------------------
// Code map
// ---------------------------------------------------------------------------

test("benchmark: code map includes key symbols", () => {
  const codeMap = index.getCodeMap();

  assert.ok(codeMap.text.includes("App"), "code map should include App");
  assert.ok(codeMap.text.includes("ConsoleLogger"), "code map should include ConsoleLogger");
  assert.ok(codeMap.text.includes("EventBus"), "code map should include EventBus");
  assert.ok(codeMap.text.includes("main"), "code map should include main");
  assert.ok(codeMap.totalCount > 0, "should report total symbol count");
});

test("benchmark: code map includes JS and TS files", () => {
  const codeMap = index.getCodeMap();

  assert.ok(codeMap.text.includes(".ts"), "code map should include .ts files");
  assert.ok(codeMap.text.includes(".js"), "code map should include .js files");
});
