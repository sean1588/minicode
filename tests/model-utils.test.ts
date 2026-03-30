import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelInfo } from "@minicode/agent-sdk";
import { sortModelsAlphabetically } from "../src/model-utils.js";

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
