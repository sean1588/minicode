import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBenchmarkToolTrace,
  buildPriorReasoningContext,
  countMutationsInMessages,
  getBenchmarkRetryReason,
  getBenchmarkRetryReminder,
  getBenchmarkSystemPromptSuffix,
  isBenchmarkApprovalSeekingResponse,
  looksLikeShellFileMutation,
  parseBenchmarkRunArgs,
  summarizeBenchmarkToolUsage,
} from "../src/cli/benchmark-run.js";
import type { SessionMessage } from "@sean.holung/minicode-sdk";

test("benchmark system prompt suffix clearly disables approval-seeking behavior", () => {
  const suffix = getBenchmarkSystemPromptSuffix();

  assert.match(suffix, /non-interactive harness/i);
  assert.match(suffix, /already approved/i);
  assert.match(suffix, /do not ask for confirmation/i);
});

test("benchmark system prompt suffix overrides iteration discipline for long-form tasks", () => {
  // Added after observing on CCBench that the base [Iteration Discipline]
  // "3-5 calls then commit" guidance was driving premature completion on
  // benchmark tasks that genuinely require 30+ iterate-test-fix cycles.
  // Both gemini-3-flash and haiku-4.5 declared "I have implemented" before
  // verifying their changes against the canonical test suite.
  const suffix = getBenchmarkSystemPromptSuffix();

  assert.match(
    suffix,
    /persistent iteration|30\+ tool-call/i,
    "should set the expectation that persistent iteration is normal",
  );
  assert.match(
    suffix,
    /canonical test runner/i,
    "should direct the model to the canonical test runner, not ad-hoc tests",
  );
  assert.match(
    suffix,
    /full existing test suite/i,
    "should require running the full suite to catch regressions",
  );
  assert.match(
    suffix,
    /explicit green signal/i,
    "should require an observed pass signal, not self-assessed completion",
  );
});

test("benchmark system prompt suffix omits runtime budget knobs", () => {
  const suffix = getBenchmarkSystemPromptSuffix();

  assert.doesNotMatch(suffix, /maxSteps/i);
  assert.doesNotMatch(suffix, /maxTokens/i);
  assert.doesNotMatch(suffix, /modelTimeoutSeconds/i);
  assert.doesNotMatch(suffix, /maxContextTokens/i);
  assert.doesNotMatch(suffix, /commandTimeoutMs/i);
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

test("getBenchmarkRetryReason flags zero-tool-call attempts as no_action", () => {
  // Pure-reasoning failure (Gemini 2.5 Pro's "thought a lot, emitted
  // nothing" mode). Despite empty text, the attempt is still a definite
  // failure in benchmark mode since the task needs code changes.
  assert.equal(
    getBenchmarkRetryReason({ text: "", toolCallCount: 0, mutationCount: 0 }),
    "no_action",
  );
  // Hallucinated-completion failure: the model narrates work without
  // making any tool calls. Caught the same way — zero tool calls is
  // the load-bearing signal, not the text.
  assert.equal(
    getBenchmarkRetryReason({
      text: "I've added the new transformation to astropy/coordinates/itrs.py and registered it with the frame_transform_graph.",
      toolCallCount: 0,
      mutationCount: 0,
    }),
    "no_action",
  );
  // Future-tense planning without action — also covered.
  assert.equal(
    getBenchmarkRetryReason({
      text: "I will add the helper function to utils.py and update the imports.",
      toolCallCount: 0,
      mutationCount: 0,
    }),
    "no_action",
  );
});

test("getBenchmarkRetryReason flags approval-seeking when tool calls exist", () => {
  assert.equal(
    getBenchmarkRetryReason({
      text: "I found the changes needed. Please confirm and I'll apply them.",
      toolCallCount: 5,
      mutationCount: 0,
    }),
    "approval_seeking",
  );
});

test("getBenchmarkRetryReason flags plan-only attempts as no_mutation", () => {
  // Observed on Gemini 2.5 Pro 71f348da: 3 read-only tool calls
  // (search_code_map + 2 read_symbol) followed by a future-tense plan
  // ("Here's how I'll fix it: 1. Read X. 2. Modify Y. 3. I'll replace Z.")
  // and no edit. Approval-seeking detector doesn't fire (no "please confirm")
  // and no_action doesn't fire (toolCallCount > 0) — needs a third signal.
  assert.equal(
    getBenchmarkRetryReason({
      text: "Here's how I'll fix it: 1. Read sliced_wcs.py. 2. Modify world_to_pixel_values. 3. I'll replace the 1. fallback.",
      toolCallCount: 3,
      mutationCount: 0,
    }),
    "no_mutation",
  );
});

test("getBenchmarkRetryReason returns null when mutations occurred", () => {
  assert.equal(
    getBenchmarkRetryReason({
      text: "Updated src/app.ts, ran npm test, all tests passed.",
      toolCallCount: 12,
      mutationCount: 2,
    }),
    null,
  );
});

test("getBenchmarkRetryReason prioritizes no_action over no_mutation", () => {
  // Defensive: a zero-tool-call attempt also has zero mutations, but the
  // reminder for no_action is more specific. Make sure that path wins.
  assert.equal(
    getBenchmarkRetryReason({
      text: "I will edit utils.py.",
      toolCallCount: 0,
      mutationCount: 0,
    }),
    "no_action",
  );
});

test("getBenchmarkRetryReminder returns distinct reminders for each reason", () => {
  const approval = getBenchmarkRetryReminder("approval_seeking");
  const noAction = getBenchmarkRetryReminder("no_action");
  const noMutation = getBenchmarkRetryReminder("no_mutation");

  // Approval reminder leans on "already approved" — the model was acting
  // but asked for permission.
  assert.match(approval, /already approved/i);
  assert.doesNotMatch(approval, /zero tool calls/i);

  // No-action reminder names the failure mode explicitly so the model
  // understands what changed.
  assert.match(noAction, /zero tool calls/i);
  assert.match(noAction, /edit_file/);
  // Calls out both the past-tense and future-tense narration traps that
  // were observed in the Gemini 2.5 Pro empty-trajectory investigation.
  assert.match(noAction, /past-tense/i);
  assert.match(noAction, /future-tense/i);

  // No-mutation reminder is distinct — the model DID call tools, just
  // never edited anything. It should mention reading-without-editing,
  // and acknowledge shell-based edits as legitimate (since some models
  // prefer `cat > file` over edit_file).
  assert.match(noMutation, /read files but never edited/i);
  assert.match(noMutation, /cat > path|sed -i/);
  assert.notEqual(noMutation, noAction);
  assert.notEqual(noMutation, approval);
});

test("looksLikeShellFileMutation detects common file-writing shells", () => {
  // Heredoc into file — the gemini-3-pro 71f348da pattern.
  assert.equal(
    looksLikeShellFileMutation("cat > path/to/file.py <<'EOF'\nbody\nEOF"),
    true,
  );
  // Append redirect with heredoc.
  assert.equal(
    looksLikeShellFileMutation("cat << 'EOF' >> tests/foo.py\nbody\nEOF"),
    true,
  );
  // In-place sed.
  assert.equal(looksLikeShellFileMutation("sed -i 's/old/new/g' foo.py"), true);
  // tee.
  assert.equal(looksLikeShellFileMutation("echo x | tee path/to/file"), true);
  // Python open().write().
  assert.equal(
    looksLikeShellFileMutation(
      'python -c "open(\'foo.py\', \'w\').write(\'body\')"',
    ),
    true,
  );
});

test("looksLikeShellFileMutation rejects read-only and benign redirects", () => {
  // Pure read.
  assert.equal(looksLikeShellFileMutation("cat path/to/file.py"), false);
  // Pipe + cat with output to /dev/null.
  assert.equal(
    looksLikeShellFileMutation("python script.py > /dev/null 2>&1"),
    false,
  );
  // File descriptor redirect (no file write).
  assert.equal(looksLikeShellFileMutation("python script.py 2>&1"), false);
  // pytest invocation — no redirect, no in-place edit.
  assert.equal(
    looksLikeShellFileMutation("python -m pytest tests/foo.py"),
    false,
  );
  // git commands operate on the index, not arbitrary file writes — we
  // don't count them as code mutations.
  assert.equal(looksLikeShellFileMutation("git checkout tests/foo.py"), false);
  assert.equal(looksLikeShellFileMutation("git add ."), false);
});

test("buildPriorReasoningContext returns empty when no reasoning was captured", () => {
  assert.equal(buildPriorReasoningContext(undefined), "");
  assert.equal(buildPriorReasoningContext(""), "");
  assert.equal(buildPriorReasoningContext("   \n\n   "), "");
});

test("buildPriorReasoningContext wraps the prior reasoning with framing", () => {
  // The wrapper tells the model this is its own prior thinking, and
  // nudges it to act on the reasoning rather than re-deliberate.
  const block = buildPriorReasoningContext(
    "The bug is the hardcoded 1.0 fallback in sliced_wcs.py line 254.",
  );
  assert.match(block, /your previous attempt/i);
  assert.match(block, /<<<PRIOR_REASONING>>>/);
  assert.match(block, /<<<END_PRIOR_REASONING>>>/);
  assert.match(block, /hardcoded 1\.0 fallback/);
  assert.match(block, /apply that reasoning/i);
});

test("buildPriorReasoningContext truncates very long reasoning", () => {
  // 12k reasoning tokens from a pure-thinking collapse would explode
  // the next attempt's input cost. Cap at 2000 chars so the retry stays
  // affordable while still preserving the high-level plan.
  const long = "x".repeat(5000);
  const block = buildPriorReasoningContext(long);
  assert.match(block, /more chars of reasoning truncated/);
  // The wrapped block should NOT contain the full 5000 chars worth of x's.
  const xCount = (block.match(/x/g) ?? []).length;
  assert.ok(xCount < 5000, `expected truncation, got ${xCount} x chars`);
  assert.ok(xCount >= 2000, `expected at least 2000 x chars preserved, got ${xCount}`);
});

test("countMutationsInMessages counts structured + shell mutations together", () => {
  const messages: SessionMessage[] = [
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "1", name: "read_file", input: { path: "a.py" } },
        { id: "2", name: "edit_file", input: { path: "a.py", old_string: "x", new_string: "y" } },
        {
          id: "3",
          name: "run_command",
          input: { command: "cat > b.py <<'EOF'\nprint('hi')\nEOF" },
        },
        { id: "4", name: "run_command", input: { command: "python -m pytest" } },
      ],
    },
    { role: "assistant", content: "done" },
  ];
  // edit_file + the heredoc command count; read_file and pytest don't.
  assert.equal(countMutationsInMessages(messages), 2);
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
  assert.equal(summary.shellMutationTotal, 0);
  assert.equal(summary.commandTotal, 1);
  assert.deepEqual(summary.repeatedToolCalls, []);
});

test("benchmark tool usage summary counts shell-based file edits as shellMutation", () => {
  // Gemini-3-Pro pattern: `cat > FILE <<EOF` heredoc instead of edit_file.
  // mutationTotal stays at the structured-tool count; shellMutationTotal
  // exposes the shell-based edits without inflating mutationTotal.
  const summary = summarizeBenchmarkToolUsage(
    [
      {
        step: 1,
        name: "run_command",
        input: { command: "cat > foo.py <<'EOF'\nprint('hi')\nEOF" },
        result: "ok",
        skipped: false,
      },
      {
        step: 2,
        name: "run_command",
        input: { command: "sed -i 's/old/new/g' bar.py" },
        result: "ok",
        skipped: false,
      },
      {
        step: 3,
        name: "run_command",
        input: { command: "python -m pytest" },
        result: "ok",
        skipped: false,
      },
    ],
    "Done",
  );

  assert.equal(summary.total, 3);
  assert.equal(summary.commandTotal, 3);
  assert.equal(summary.mutationTotal, 0);
  assert.equal(summary.shellMutationTotal, 2);
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
