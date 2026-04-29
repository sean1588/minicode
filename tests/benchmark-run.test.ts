import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getBenchmarkSystemPromptSuffix,
  isBenchmarkApprovalSeekingResponse,
  parseBenchmarkRunArgs,
} from "../src/cli/benchmark-run.js";

test("benchmark system prompt suffix clearly disables approval-seeking behavior", () => {
  const suffix = getBenchmarkSystemPromptSuffix();

  assert.match(suffix, /non-interactive benchmark harness/i);
  assert.match(suffix, /already approved/i);
  assert.match(suffix, /do not ask for confirmation/i);
});

test("approval-seeking benchmark responses are detected", () => {
  assert.equal(
    isBenchmarkApprovalSeekingResponse(
      "I found the changes needed. Please confirm and I'll apply them.",
    ),
    true,
  );
  assert.equal(
    isBenchmarkApprovalSeekingResponse(
      "May I proceed with these changes?",
    ),
    true,
  );
});

test("normal benchmark summaries are not treated as approval-seeking", () => {
  assert.equal(
    isBenchmarkApprovalSeekingResponse(
      "Updated src/app.ts, ran npm test once, and all tests passed.",
    ),
    false,
  );
  assert.equal(
    isBenchmarkApprovalSeekingResponse(
      "The task is blocked because the repository does not contain the referenced file.",
    ),
    false,
  );
});

test("parseBenchmarkRunArgs preserves prompt text and benchmark flags", () => {
  const args = parseBenchmarkRunArgs([
    "--verbose",
    "--config",
    "benchmarks/benchmark.config.json",
    "--env-file",
    "benchmarks/benchmark.env",
    "--provider",
    "openai-compatible",
    "--model",
    "openai/gpt-5",
    "--base-url",
    "https://openrouter.ai/api/v1",
    "--workspace-root",
    ".",
    "--out",
    "artifacts/result.json",
    "Solve",
    "the",
    "exercise",
  ]);

  assert.equal(args.verbose, true);
  assert.equal(args.prompt, "Solve the exercise");
  assert.equal(args.configPath, "benchmarks/benchmark.config.json");
  assert.deepEqual(args.envFiles, ["benchmarks/benchmark.env"]);
  assert.equal(args.provider, "openai-compatible");
  assert.equal(args.model, "openai/gpt-5");
  assert.equal(args.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(args.workspaceRoot, ".");
  assert.equal(args.outFile, "artifacts/result.json");
});
