import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { generateCodeMap } from "../src/indexer/code-map.js";
import { getPluginForFile, loadPlugins } from "../src/indexer/plugin-loader.js";
import { buildProjectIndex } from "../src/indexer/project-index.js";
import { typescriptPlugin } from "../src/indexer/plugins/typescript.js";

const SAMPLE_TS = `
export interface Foo {
  bar: string;
}

export function hello(name: string): string {
  return \`Hello, \${name}\`;
}

export class CodingAgent {
  constructor(params: { config: unknown }) {}

  async runTurn(input: string): Promise<string> {
    return input;
  }
}

const arrowFn = (x: number) => x + 1;
`;

test("TypeScript plugin extracts functions, classes, interfaces", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);

  const names = symbols.map((s) => s.qualifiedName);
  assert.ok(names.includes("Foo"), "should extract interface Foo");
  assert.ok(names.includes("hello"), "should extract function hello");
  assert.ok(names.includes("CodingAgent"), "should extract class CodingAgent");
  assert.ok(names.includes("CodingAgent.runTurn"), "should extract method runTurn");
  assert.ok(names.includes("arrowFn"), "should extract arrow function");
});

test("TypeScript plugin returns correct line numbers", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);

  const hello = symbols.find((s) => s.name === "hello");
  assert.ok(hello, "should find hello");
  assert.ok(hello!.startLine >= 6 && hello!.startLine <= 10);
  assert.ok(hello!.endLine > hello!.startLine);
});

test("TypeScript plugin handles arrow functions assigned to const", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);

  const arrow = symbols.find((s) => s.name === "arrowFn");
  assert.ok(arrow, "should find arrowFn");
  assert.equal(arrow!.kind, "function");
});

test("Plugin loader returns the built-in TypeScript plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  assert.ok(plugins.length >= 1);
  assert.ok(plugins.some((p) => p.name === "typescript"));
});

test("getPluginForFile routes .ts files to TypeScript plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  const plugin = getPluginForFile("src/agent/agent.ts", plugins);
  assert.ok(plugin);
  assert.equal(plugin!.name, "typescript");
});

test("verify-index fixture exercises full indexing pipeline", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const fixtureRoot = path.join(root, "test-programs", "verify-index");
  const index = await buildProjectIndex(fixtureRoot);

  assert.ok(index.getSymbol("Processor"), "Processor class");
  assert.ok(index.getSymbol("Processor.run"), "Processor.run method");
  assert.ok(index.getSymbol("parse"), "parse function");
  assert.ok(index.getSymbol("Task"), "Task interface");

  const taskRefs = index.dependencyEdges.filter((e) => e.to === "Task");
  assert.ok(taskRefs.length >= 2, "Task should have multiple references");

  const implementsEdges = index.dependencyEdges.filter(
    (e) => e.kind === "implements" && e.from === "Processor",
  );
  assert.ok(implementsEdges.length >= 1, "Processor should implement TaskRunner");

  const codeMap = index.getCodeMap();
  assert.ok(codeMap.includes("Processor"));
  assert.ok(codeMap.includes("parseAndProcess"));
});

test("Code map generator produces expected format", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);
  const byFile = new Map([["sample.ts", symbols]]);
  const map = generateCodeMap(byFile);

  assert.ok(map.includes("# Project Code Map"));
  assert.ok(map.includes("sample.ts"));
  assert.ok(map.includes("CodingAgent"));
  assert.ok(map.includes("runTurn"));
});

test("Code map respects token budget", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);
  const byFile = new Map([["sample.ts", symbols]]);
  const map = generateCodeMap(byFile, 50);

  assert.ok(map.length < 300);
  assert.ok(
    map.includes("... and") || map.length > 0,
    "should truncate or fit within budget",
  );
});

test("buildProjectIndex works on minicode src/", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  assert.ok(index.symbols.size > 0);
  assert.ok(index.files.size > 0);

  const agentSymbols = index.getSymbolsInFile("src/agent/agent.ts");
  assert.ok(agentSymbols.length >= 1);
  assert.ok(agentSymbols.some((s) => s.name === "CodingAgent"));

  const codeMap = index.getCodeMap();
  assert.ok(codeMap.includes("CodingAgent"));
  assert.ok(codeMap.includes("runTurn"));
});

test("getPluginForFile routes .tsx, .js, .jsx to TypeScript plugin", async () => {
  const plugins = await loadPlugins("/tmp");
  const tsx = getPluginForFile("src/component.tsx", plugins);
  const js = getPluginForFile("src/legacy.js", plugins);
  const jsx = getPluginForFile("src/component.jsx", plugins);
  assert.ok(tsx);
  assert.ok(js);
  assert.ok(jsx);
  assert.equal(tsx!.name, "typescript");
});

test("TypeScript plugin extracts constructor", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);
  const ctor = symbols.find(
    (s) => s.qualifiedName === "CodingAgent.constructor",
  );
  assert.ok(ctor, "should extract constructor");
  assert.equal(ctor!.kind, "method");
});

test("TypeScript plugin extracts type alias", () => {
  const code = `export type UserId = string;`;
  const symbols = typescriptPlugin.indexFile("types.ts", code);
  const typeSym = symbols.find((s) => s.name === "UserId");
  assert.ok(typeSym, "should extract type alias");
  assert.equal(typeSym!.kind, "type");
});

test("TypeScript plugin returns empty array for empty file", () => {
  const symbols = typescriptPlugin.indexFile("empty.ts", "");
  assert.equal(symbols.length, 0);
});

test("TypeScript plugin handles comments-only file", () => {
  const symbols = typescriptPlugin.indexFile(
    "comments.ts",
    "// comment only\n/* block */",
  );
  assert.equal(symbols.length, 0);
});

test("TypeScript plugin handles malformed syntax", () => {
  const symbols = typescriptPlugin.indexFile("bad.ts", "function { broken");
  assert.ok(Array.isArray(symbols));
});

test("ProjectIndex getSymbol finds by qualifiedName and by name", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const byQualified = index.getSymbol("CodingAgent.runTurn");
  assert.ok(byQualified);
  assert.equal(byQualified!.qualifiedName, "CodingAgent.runTurn");

  const byName = index.getSymbol("runTurn");
  assert.ok(byName, "getSymbol should find by name when unique");
});

test("ProjectIndex getSymbolsInFile returns empty for non-existent file", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const symbols = index.getSymbolsInFile("src/nonexistent.ts");
  assert.ok(Array.isArray(symbols));
  assert.equal(symbols.length, 0);
});

test("ProjectIndex getDependencyCone returns target and dependencies", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const cone = index.getDependencyCone("parseResponse", 1);
  assert.ok(Array.isArray(cone));
  assert.ok(cone.length >= 1, "should include target symbol");
  assert.ok(
    cone.some((s) => s.qualifiedName === "parseResponse"),
    "should include parseResponse",
  );
});

test("Code map handles empty symbols map", () => {
  const map = generateCodeMap(new Map());
  assert.ok(map.includes("# Project Code Map"));
  assert.ok(map.length < 100);
});

test("Code map nests methods under class", () => {
  const symbols = typescriptPlugin.indexFile("sample.ts", SAMPLE_TS);
  const byFile = new Map([["sample.ts", symbols]]);
  const map = generateCodeMap(byFile);

  assert.ok(map.includes("class CodingAgent"));
  assert.ok(map.includes("runTurn"));
  const runTurnLine = map.split("\n").find((l) => l.includes("runTurn"));
  assert.ok(runTurnLine?.startsWith("    "), "method should be indented under class");
});

test("reindexFile updates symbols and code map after file change", async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "minicode-reindex-"));
  const samplePath = path.join(workspaceRoot, "sample.ts");
  const initialContent = `export function greet(name: string): string {
  return \`Hello, \${name}\`;
}
`;
  await writeFile(samplePath, initialContent, "utf8");

  const index = await buildProjectIndex(workspaceRoot);
  const sym = index.getSymbol("greet");
  assert.ok(sym, "should find greet");
  assert.ok(sym!.signature.includes("name: string"), "initial signature");

  const updatedContent = `export function greet(name: string, title?: string): string {
  return title ? \`Hello, \${title} \${name}\` : \`Hello, \${name}\`;
}
`;
  index.reindexFile("sample.ts", updatedContent);

  const updatedSym = index.getSymbol("greet");
  assert.ok(updatedSym, "should still find greet");
  assert.ok(
    updatedSym!.signature.includes("title?: string"),
    "signature should reflect updated params",
  );

  const codeMap = index.getCodeMap();
  assert.ok(codeMap.includes("title?: string"), "code map should reflect new signature");
});
