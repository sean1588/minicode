import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBenchmarkToolTrace,
  getBenchmarkSystemPromptSuffix,
  isBenchmarkApprovalSeekingResponse,
  parseBenchmarkRunArgs,
  summarizeBenchmarkToolUsage,
} from "../src/cli/benchmark-run.js";
import type { SessionMessage } from "@minicode/agent-sdk";

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

test("buildBenchmarkToolTrace extracts assistant tool calls and matching results", () => {
  const messages: SessionMessage[] = [
    { role: "user", content: "solve it" },
    {
      role: "assistant",
      content: "reading",
      toolCalls: [
        { id: "call-1", name: "read_symbol", input: { name: "parse" } },
        { id: "call-2", name: "read_file", input: { path: "parse.ts" } },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-1",
      toolName: "read_symbol",
      content: "symbol body",
    },
    {
      role: "tool",
      toolCallId: "call-2",
      toolName: "read_file",
      content: "file body",
    },
    { role: "assistant", content: "done" },
  ];

  const trace = buildBenchmarkToolTrace(messages);

  assert.deepEqual(trace, [
    {
      step: 1,
      name: "read_symbol",
      input: { name: "parse" },
      result: "symbol body",
      skipped: false,
    },
    {
      step: 1,
      name: "read_file",
      input: { path: "parse.ts" },
      result: "file body",
      skipped: false,
    },
  ]);
});

test("benchmark tool usage summary separates structured tools from file reads", () => {
  const summary = summarizeBenchmarkToolUsage(
    [
      {
        step: 1,
        name: "read_symbol",
        input: { name: "parse" },
        result: "symbol body",
        skipped: false,
      },
      {
        step: 1,
        name: "get_dependencies",
        input: { name: "parse" },
        result: "deps",
        skipped: false,
      },
      {
        step: 2,
        name: "read_file",
        input: { path: "parse.ts" },
        result: "file body",
        skipped: false,
      },
      {
        step: 3,
        name: "edit_file",
        input: { path: "parse.ts", old_string: "a", new_string: "b" },
        result: "edited",
        skipped: false,
      },
      {
        step: 4,
        name: "run_command",
        input: { command: "npm test" },
        result: "ok",
        skipped: false,
      },
    ],
    "Done",
  );

  assert.equal(summary.total, 5);
  assert.equal(summary.specializedTotal, 2);
  assert.equal(summary.specializedByName.read_symbol, 1);
  assert.equal(summary.specializedByName.get_dependencies, 1);
  assert.equal(summary.fileReadTotal, 1);
  assert.equal(summary.mutationTotal, 1);
  assert.equal(summary.commandTotal, 1);
  assert.deepEqual(summary.repeatedToolCalls, []);
});

test("benchmark tool usage summary reports repeated-call stops", () => {
  const summary = summarizeBenchmarkToolUsage(
    [
      {
        step: 1,
        name: "read_file",
        input: { path: "accumulate.ts" },
        result: "stub",
        skipped: false,
      },
      {
        step: 2,
        name: "read_file",
        input: { path: "accumulate.ts" },
        result: "stub",
        skipped: false,
      },
      {
        step: 3,
        name: "read_file",
        input: { path: "accumulate.ts" },
        result: "Tool skipped: Stopped due to repeated identical tool calls. Please refine the prompt or provide additional constraints.",
        skipped: true,
      },
    ],
    "Stopped due to repeated identical tool calls. Please refine the prompt or provide additional constraints.",
  );

  assert.equal(summary.repeatedStop, true);
  assert.equal(summary.skippedTotal, 1);
  assert.deepEqual(summary.repeatedToolCalls, [
    {
      name: "read_file",
      input: { path: "accumulate.ts" },
      count: 3,
    },
  ]);
});
