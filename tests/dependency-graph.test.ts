import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";

test("buildProjectIndex produces dependency edges", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  assert.ok(index.dependencyEdges.length > 0, "should have dependency edges");

  const createToolRegistryRefs = index.dependencyEdges.filter(
    (e) => e.from === "createToolRegistry",
  );
  assert.ok(
    createToolRegistryRefs.some((e) => e.to === "ProjectIndex"),
    "createToolRegistry should reference ProjectIndex",
  );
  assert.ok(
    createToolRegistryRefs.some((e) => e.to === "AgentConfig"),
    "createToolRegistry should reference AgentConfig",
  );
});

test("loadAgentConfig has expected dependencies", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const edges = index.dependencyEdges.filter(
    (e) => e.from === "loadAgentConfig",
  );

  assert.ok(
    edges.some((e) => e.to === "AgentConfig"),
    "loadAgentConfig should reference AgentConfig",
  );
  assert.ok(
    edges.length >= 1,
    "loadAgentConfig should have at least one dependency",
  );
});

test("buildProjectIndex indexes config and tool files", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const configSymbols = index.getSymbolsInFile("src/agent/config.ts");
  assert.ok(
    configSymbols.some((s) => s.name === "loadAgentConfig"),
    "should index loadAgentConfig from config.ts",
  );

  const registrySymbols = index.getSymbolsInFile("src/tools/registry.ts");
  assert.ok(
    registrySymbols.some((s) => s.name === "createToolRegistry"),
    "should index createToolRegistry from registry.ts",
  );
});
