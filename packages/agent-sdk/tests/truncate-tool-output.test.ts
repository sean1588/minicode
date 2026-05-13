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

test("truncateToolOutput run_command keeps both head and tail with self-identifying footer", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = truncateToolOutput("run_command", lines, 200);
  // Tail is preserved (errors/results live there for normal failures).
  assert.match(out, /line 200$/);
  // Head is ALSO preserved — for runaway outputs (infinite loops etc),
  // the diagnostic pattern lives at the start. A tail-only split hides
  // it. See the failure-mode analysis from the 2026-05-13 CCBench
  // investigation: gemini-3-flash's Lox interpreter wrote an infinite
  // loop, the program emitted 4.3 MB of integers, and a tail-heavy
  // truncation showed the model only "more integers" — never the start.
  assert.match(out, /^line 1\n/);
  // Footer identifies the layer and the tool.
  assert.match(out, /agent-level truncation/);
  assert.match(out, /run_command/);
});

test("truncateToolOutput run_command flags pathologically large omissions", () => {
  // Output that's >10× the budget gets an extra hint that runaway
  // output is a likely cause. The model should be steered to examine
  // the head, not just trust the tail.
  const huge = "x".repeat(50_000);
  const out = truncateToolOutput("run_command", huge, 1000);
  assert.match(out, /runaway output|infinite loop|recursion|excessive logging/);
});

test("truncateToolOutput run_command does NOT flag normal-sized omissions", () => {
  // Output only slightly over the budget gets the plain truncation
  // footer — no runaway hint, since "small overrun" is the common case
  // (a normal command with a long-but-bounded output).
  const modest = "y".repeat(1500);
  const out = truncateToolOutput("run_command", modest, 1000);
  assert.doesNotMatch(out, /runaway output/);
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
