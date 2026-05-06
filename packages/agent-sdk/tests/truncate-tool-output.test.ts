import assert from "node:assert/strict";
import { test } from "node:test";

import { truncateToolOutput } from "../src/agent/agent.js";

// All footers should identify themselves as "agent-level" so the model
// can tell the cut was applied here rather than by the tool itself.
// Without that label, when an agent-level char cap chops through a
// tool's own truncation footer, the agent sees a hybrid footer and
// can't reason about which layer to retry against.

test("truncateToolOutput returns input unchanged when under maxChars", () => {
  const out = truncateToolOutput("read_file", "small body", 1000);
  assert.equal(out, "small body");
});

test("truncateToolOutput never truncates read_file even over maxChars", () => {
  const big = "x".repeat(2000);
  const out = truncateToolOutput("read_file", big, 100);
  // read_file content is exempt — the model needs the exact bytes for
  // edits, and read_file's own range footer already tells the model
  // when content was clipped at the tool layer.
  assert.equal(out, big);
});

test("truncateToolOutput run_command keeps tail with self-identifying footer", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = truncateToolOutput("run_command", lines, 200);
  // Tail is preserved (errors/results live there).
  assert.match(out, /line 200$/);
  // Footer identifies the layer and the tool.
  assert.match(out, /agent-level truncation/);
  assert.match(out, /run_command/);
});

test("truncateToolOutput search keeps head with line count and remediation hint", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `match-${i}`).join("\n");
  const out = truncateToolOutput("search", lines, 300);
  assert.match(out, /agent-level truncation/);
  assert.match(out, /\d+ of 200 match lines/);
  assert.match(out, /Narrow the search/);
});

test("truncateToolOutput default head-only footer names the tool that was truncated", () => {
  const big = "x".repeat(2000);
  const out = truncateToolOutput("read_symbol", big, 500);
  // Footer must say agent-level + name the source tool so the model
  // can target a retry (`read_symbol` with a more specific name, etc.).
  assert.match(out, /agent-level truncation/);
  assert.match(out, /read_symbol/);
  assert.match(out, /500 of 2000 chars/);
});

test("truncateToolOutput default footer suggests retry direction", () => {
  const big = "y".repeat(2000);
  const out = truncateToolOutput("list_files", big, 500);
  // Doesn't have to be a specific phrase — just enough that the agent
  // sees an action it could take. The exact suggestions vary by tool
  // strategy; for the default head path we just need the elided count
  // so the agent knows scope of the loss.
  assert.match(out, /\d+ more chars elided/);
});

test("truncateToolOutput zero-or-negative maxChars disables truncation", () => {
  const big = "z".repeat(5000);
  assert.equal(truncateToolOutput("read_symbol", big, 0), big);
  assert.equal(truncateToolOutput("read_symbol", big, -1), big);
});
