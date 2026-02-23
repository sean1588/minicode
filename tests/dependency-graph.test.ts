import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { buildProjectIndex } from "../src/indexer/project-index.js";

test("buildProjectIndex produces dependency edges", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  assert.ok(index.dependencyEdges.length > 0, "should have dependency edges");

  const parseResponseRefs = index.dependencyEdges.filter(
    (e) => e.from === "parseResponse",
  );
  assert.ok(
    parseResponseRefs.some((e) => e.to === "ModelResponse"),
    "parseResponse should reference ModelResponse",
  );
  assert.ok(
    parseResponseRefs.some((e) => e.to === "ToolCall"),
    "parseResponse should reference ToolCall",
  );
});

test("createModelClient has expected dependencies", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const edges = index.dependencyEdges.filter(
    (e) => e.from === "createModelClient",
  );

  assert.ok(
    edges.some((e) => e.to === "AgentConfig"),
    "createModelClient should reference AgentConfig",
  );
  assert.ok(
    edges.length >= 1,
    "createModelClient should have at least one dependency",
  );
});

test("AnthropicModelClient implements ModelClient", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = await buildProjectIndex(root);

  const implementsEdge = index.dependencyEdges.find(
    (e) =>
      e.from === "AnthropicModelClient" &&
      e.to === "ModelClient" &&
      e.kind === "implements",
  );
  assert.ok(implementsEdge, "AnthropicModelClient should implement ModelClient");
});
