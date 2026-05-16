import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContextBenchTrajectory,
  parsePatchSpans,
} from "../src/cli/contextbench-trajectory.js";
import type { BenchmarkToolCallTrace } from "../src/cli/benchmark-run.js";

function trace(
  step: number,
  name: string,
  input: Record<string, unknown>,
  result: string | null = null,
  skipped = false,
): BenchmarkToolCallTrace {
  return { step, name, input, result, skipped };
}

test("read_file with explicit offset and limit becomes a tight explore_context span", () => {
  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix the bug.",
    toolCalls: [trace(1, "read_file", { path: "app/main.py", offset: 10, limit: 30 })],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
  });

  const explore = trajectory.messages.find(
    (m) => m.role === "assistant" && m.content.includes("<explore_context>"),
  );
  assert.ok(explore, "should emit one explore_context message");
  assert.match(explore.content, /File: app\/main\.py/);
  // offset=10, limit=30 → lines 10..39 (start + limit - 1)
  assert.match(explore.content, /Lines: 10-39/);
});

test("read_file without offset/limit prefers the result's last line-number prefix", () => {
  const numberedContent =
    Array.from({ length: 5 }, (_, i) => `${i + 1}|line ${i + 1}`).join("\n") + "\n";
  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix the bug.",
    toolCalls: [trace(1, "read_file", { path: "app/foo.py" }, numberedContent)],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
  });

  const explore = trajectory.messages.find((m) =>
    m.content.includes("<explore_context>"),
  );
  assert.ok(explore);
  assert.match(explore.content, /File: app\/foo\.py\nLines: 1-5/);
});

test("read_file with unparseable result and no offset/limit is omitted", () => {
  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix.",
    toolCalls: [trace(1, "read_file", { path: "x.py" }, "no line numbers here")],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
  });
  // Only the final PATCH_CONTEXT assistant message should be present;
  // no explore_context for this step because we couldn't bound it safely.
  const exploreMessages = trajectory.messages.filter((m) =>
    m.content.includes("<explore_context>"),
  );
  assert.equal(exploreMessages.length, 0);
});

test("read_symbol consults the project index to derive file+lines", () => {
  const stubIndex = {
    getSymbol: (name: string) =>
      name === "Foo.bar"
        ? {
            name: "bar",
            qualifiedName: "Foo.bar",
            kind: "method",
            filePath: "src/foo.ts",
            startLine: 42,
            endLine: 71,
            signature: "bar()",
            exported: false,
            dependencies: [],
          }
        : undefined,
    getSymbolMatches: () => [],
    dependencyEdges: [],
    getDependencyCone: () => [],
  } as unknown as Parameters<typeof buildContextBenchTrajectory>[0]["projectIndex"];

  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix.",
    toolCalls: [trace(1, "read_symbol", { name: "Foo.bar" })],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
    ...(stubIndex !== undefined ? { projectIndex: stubIndex } : {}),
  });

  const explore = trajectory.messages.find((m) =>
    m.content.includes("<explore_context>"),
  );
  assert.ok(explore);
  assert.match(explore.content, /File: src\/foo\.ts\nLines: 42-71/);
});

test("find_references emits a span per incoming-edge source symbol", () => {
  const symbols = {
    "Foo.bar": {
      name: "bar",
      qualifiedName: "Foo.bar",
      kind: "method",
      filePath: "src/foo.ts",
      startLine: 10,
      endLine: 20,
      signature: "",
      exported: false,
      dependencies: [],
    },
    callerOne: {
      name: "callerOne",
      qualifiedName: "callerOne",
      kind: "function",
      filePath: "src/caller-one.ts",
      startLine: 100,
      endLine: 110,
      signature: "",
      exported: false,
      dependencies: [],
    },
    callerTwo: {
      name: "callerTwo",
      qualifiedName: "callerTwo",
      kind: "function",
      filePath: "src/caller-two.ts",
      startLine: 200,
      endLine: 220,
      signature: "",
      exported: false,
      dependencies: [],
    },
  };

  const stubIndex = {
    getSymbol: (name: string) => symbols[name as keyof typeof symbols],
    getSymbolMatches: () => [],
    dependencyEdges: [
      { from: "callerOne", to: "Foo.bar", kind: "calls" },
      { from: "callerTwo", to: "Foo.bar", kind: "calls" },
    ],
    getDependencyCone: () => [],
  } as unknown as Parameters<typeof buildContextBenchTrajectory>[0]["projectIndex"];

  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix.",
    toolCalls: [trace(1, "find_references", { name: "Foo.bar" })],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
    ...(stubIndex !== undefined ? { projectIndex: stubIndex } : {}),
  });

  const explore = trajectory.messages.find((m) =>
    m.content.includes("<explore_context>"),
  );
  assert.ok(explore);
  assert.match(explore.content, /File: src\/caller-one\.ts\nLines: 100-110/);
  assert.match(explore.content, /File: src\/caller-two\.ts\nLines: 200-220/);
});

test("PATCH_CONTEXT is computed from the unified diff's new-file hunk ranges", () => {
  const patch = [
    "diff --git a/app/main.py b/app/main.py",
    "--- a/app/main.py",
    "+++ b/app/main.py",
    "@@ -10,5 +12,7 @@",
    " unchanged",
    "-removed",
    "+added",
    "+added 2",
    "diff --git a/app/util.py b/app/util.py",
    "--- a/app/util.py",
    "+++ b/app/util.py",
    "@@ -1,3 +1,4 @@",
    "+new helper",
    " a",
    " b",
    " c",
  ].join("\n");

  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix.",
    toolCalls: [],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch,
  });

  const final = trajectory.messages[trajectory.messages.length - 1]!;
  assert.match(final.content, /<PATCH_CONTEXT>/);
  // 12,7 → new lines 12..18
  assert.match(final.content, /File: app\/main\.py\nLines: 12-18/);
  // 1,4 → new lines 1..4
  assert.match(final.content, /File: app\/util\.py\nLines: 1-4/);
  assert.equal(trajectory.info.submission, patch);
});

test("skipped tool calls do not contribute spans (e.g. loop-guard nudges)", () => {
  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "system",
    userPrompt: "Fix.",
    toolCalls: [
      trace(1, "read_file", { path: "x.py", offset: 1, limit: 10 }, "ok", false),
      trace(2, "read_file", { path: "x.py", offset: 1, limit: 10 }, "[loop guard: ...]", true),
    ],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
  });

  const exploreMessages = trajectory.messages.filter((m) =>
    m.content.includes("<explore_context>"),
  );
  // Only the first (non-skipped) call should produce an explore_context.
  assert.equal(exploreMessages.length, 1);
});

test("messages always lead with system + user roles", () => {
  const trajectory = buildContextBenchTrajectory({
    systemPrompt: "you are an agent",
    userPrompt: "fix the issue",
    toolCalls: [],
    finalAssistantText: "Done.",
    workspaceRoot: "/workspace",
    patch: "",
  });

  assert.equal(trajectory.messages[0]?.role, "system");
  assert.equal(trajectory.messages[0]?.content, "you are an agent");
  assert.equal(trajectory.messages[1]?.role, "user");
  assert.equal(trajectory.messages[1]?.content, "fix the issue");
});

test("parsePatchSpans handles +N,0 hunks (deletion-only at line N)", () => {
  const patch = [
    "diff --git a/a.py b/a.py",
    "--- a/a.py",
    "+++ b/a.py",
    "@@ -5,3 +5,0 @@",
    "-removed",
    "-removed",
    "-removed",
  ].join("\n");
  const spans = parsePatchSpans(patch);
  // Count=0 means the new file has no lines at this hunk position; degenerate
  // case — we still emit a 1-line span at the starting line so the file is
  // surfaced rather than dropped.
  assert.equal(spans.length, 1);
  assert.equal(spans[0]?.file, "a.py");
  assert.equal(spans[0]?.startLine, 5);
  assert.equal(spans[0]?.endLine, 5);
});

test("parsePatchSpans returns empty list for an empty diff", () => {
  assert.deepEqual(parsePatchSpans(""), []);
  assert.deepEqual(parsePatchSpans("\n\n  \n"), []);
});
