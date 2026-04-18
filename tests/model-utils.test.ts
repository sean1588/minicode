import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelInfo } from "@minicode/agent-sdk";
import { filterModelsByQuery, getModelDisplayName, sortModelsAlphabetically } from "../src/model-utils.js";

test("sortModelsAlphabetically sorts by display name without mutating input", () => {
  const models: ModelInfo[] = [
    { id: "zeta-2", name: "Zeta 2" },
    { id: "alpha-10", name: "alpha 10" },
    { id: "alpha-2", name: "Alpha 2" },
    { id: "beta-id" },
  ];

  const sorted = sortModelsAlphabetically(models);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["alpha-2", "alpha-10", "beta-id", "zeta-2"],
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ["zeta-2", "alpha-10", "alpha-2", "beta-id"],
  );
});

test("sortModelsAlphabetically uses id as a stable tiebreaker", () => {
  const models: ModelInfo[] = [
    { id: "gpt-4.1-b", name: "GPT-4.1" },
    { id: "gpt-4.1-a", name: "GPT-4.1" },
  ];

  const sorted = sortModelsAlphabetically(models);

  assert.deepEqual(
    sorted.map((model) => model.id),
    ["gpt-4.1-a", "gpt-4.1-b"],
  );
});

test("getModelDisplayName falls back to id and trims whitespace", () => {
  assert.equal(getModelDisplayName({ id: "google/gemini-2.5-flash-preview", name: "  Gemini 2.5 Flash  " }), "Gemini 2.5 Flash");
  assert.equal(getModelDisplayName({ id: "qwen/qwen3-coder" }), "qwen/qwen3-coder");
});

test("filterModelsByQuery matches on display name and id without mutating order", () => {
  const models: ModelInfo[] = [
    { id: "z-ai/glm-4.5-air", name: "GLM 4.5 Air" },
    { id: "google/gemini-2.5-flash-preview", name: "Gemini 2.5 Flash" },
    { id: "openai/gpt-4.1-mini", name: "GPT-4.1 Mini" },
  ];

  const byName = filterModelsByQuery(models, "gemini flash");
  const byId = filterModelsByQuery(models, "glm-4.5");
  const blank = filterModelsByQuery(models, "   ");

  assert.deepEqual(byName.map((model) => model.id), ["google/gemini-2.5-flash-preview"]);
  assert.deepEqual(byId.map((model) => model.id), ["z-ai/glm-4.5-air"]);
  assert.deepEqual(blank.map((model) => model.id), models.map((model) => model.id));
});

test("filterModelsByQuery returns all tokens match across name and id", () => {
  const models: ModelInfo[] = [
    { id: "google/gemini-2.5-flash-preview", name: "Gemini Flash Preview" },
    { id: "google/gemini-2.5-pro-preview", name: "Gemini Pro Preview" },
  ];

  const filtered = filterModelsByQuery(models, "google flash");

  assert.deepEqual(filtered.map((model) => model.id), ["google/gemini-2.5-flash-preview"]);
});
