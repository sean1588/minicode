# Leveraging Jev inside the minicode harness

Status: proposal (September 2026). Nothing in this document is implemented yet.

## What Jev is, in harness terms

Jev (`typesafe/jev-1.13`, alias `~typesafe/jev-latest`) is TypeSafe's "System One"
decision model. It does not generate text. You give it a **state** (a string, a JSON
object, or an array) and a map of **typed questions**, and it returns a typed answer
per question with a calibrated probability distribution, in one parallel pass.

| Primitive | Ask | Returns |
|-----------|-----|---------|
| `noul`    | A yes/no proposition about the state | `noul: 0..1` (probability the proposition holds) |
| `choice`  | Pick one of up to 255 labelled options | `choice`, `probabilities` per option, `confidence` |
| `score`   | Rate the state on 2 to 10 ordered levels | `score` (probability-weighted), `probabilities`, `confidence` |

Operational facts that shape how it fits an agent loop:

- **Endpoint.** `POST https://openrouter.ai/api/alpha/decisions` with the normal
  OpenRouter bearer key. minicode already treats OpenRouter as a first-class provider
  (`OPENROUTER_API_KEY`, the web connect flow), so no new credential is needed.
- **Cost.** $0.042 per million input tokens, output free. A typical 450-token call is
  about $0.00002. Fifty calls per turn would cost a tenth of a cent.
- **Latency.** Roughly 70 to 500 ms per call. All questions in one request are
  evaluated in parallel, so adding questions barely changes latency. Fan out many
  questions over one state rather than making many calls.
- **Limits.** 32k tokens of state; 64k total per request. Non-English text is weaker.
- **Calibration.** Probabilities are calibrated in aggregate. Thresholds are policy
  and belong in code, tuned per decision (higher for destructive actions).
- **Known jagged edges (from TypeSafe's own list).** It reads literally; it cannot
  count, do arithmetic, or compare dates; large irrelevant state distracts it; it does
  not treat data as hostile unless the criteria say so; double negatives and multi-hop
  indirection hurt. So: compute counts in code and pass them as named fields, filter
  state before sending it, and write explicit criteria.

The pattern that works (and that `jev-playground` already uses): Jev answers narrow
questions, code composes the verdict with named thresholds. Change a number, not a
prompt, to change behaviour.

## Where minicode makes judgment calls today

Every one of these is currently a regex, a counter, a position rule, or nothing:

| Decision | Today | Where |
|----------|-------|-------|
| Is the turn actually finished? | "no tool calls" ends the turn, whatever the text says | `packages/agent-sdk/src/agent/agent.ts:680` |
| Did the benchmark run collapse, seek approval, or only plan? | `toolCallCount === 0`, 10 regexes, mutation regexes | `src/cli/benchmark-run.ts:196-257, 365-380` |
| Is this command dangerous? | 4 destructive regexes + a static denylist | `packages/agent-sdk/src/safety/guardrails.ts:3-8`, `src/agent/config.ts:148-158` |
| Should this tool call be auto-allowed? | Tool name bucket, never looks at arguments | `src/auto-allow.ts:23-37` |
| Is the agent stuck in a loop? | Exact fingerprint repeated 3 times in a window of 6 | `agent.ts:753-822` |
| Which messages to shrink or drop? | Oldest first, tool results first, never by content | `packages/agent-sdk/src/session/session.ts:110-141, 371-411` |
| Which part of a tool output to keep? | By tool name only (head, tail, head+count) | `agent.ts:186-231` |
| Is this thinking trace worth keeping? | Always cut to 200 chars | `agent.ts:738-751` |
| Which symbols belong in the code map? | exported > reference count > entry point, files alphabetical | `src/indexer/code-map.ts:88-171` |
| Which of N matching symbols did the model mean? | List up to 12 and let the model pick | `src/shared/symbol-resolution.ts:42-64` |
| Did the tool call succeed? | Every result is marked "success" in the CLI | `src/ui/cli-ink.ts:93-96` |
| Is this structural finding real? | Hand-tuned suppression heuristics | `src/analysis/structural-analysis.ts:188-229` |
| Did the response satisfy the rubric? | Regex over the response | `src/benchmark/evaluator.ts:24-76` |

The benchmark notes (`benchmarks/ccbench/RESULTS.md`, `benchmarks/STRATEGY.md`) say the
dominant failure modes are **under-action** (inspect, never edit), **approval-seeking**,
and **tool loops**. The first three ideas below target exactly those.

## Ideas, ranked

Each idea lists the hook, the state and questions, how code composes the answer, and
the failure posture (advisory decisions fail open; safety decisions fail closed).

### 1. End-of-turn outcome gate (highest value)

**Hook.** `agent.ts:680`, the `toolCalls.length === 0` branch, and
`getBenchmarkRetryReason` in `src/cli/benchmark-run.ts:365`.

**Problem.** A text-only reply ends the turn. That includes "Here is my plan…",
"Shall I proceed?", "I'll now edit the file" with no call, and "I couldn't find it".
Benchmark mode has a one-shot regex retry for this; the interactive CLI and web UI
have nothing.

**State.** `{ task: <first user message>, reply: <final text>, tool_calls_this_turn: N,
mutations_this_turn: N, mode: "interactive" | "autonomous" }`. Counts come from code
because Jev does not count.

**Questions (one call).**
- `outcome` (choice): `done` / `plan_only` / `asking_permission` /
  `clarifying_question` / `gave_up` / `narrated_action_without_acting`.
- `claims_changes` (noul): "Does the reply say that files were changed or a command was run?"
- `needs_user_input` (noul): "Can the agent not continue without an answer from the user?"

**Composition.**
- Autonomous modes (benchmark, `/v1/chat/completions`, CI): `plan_only`,
  `asking_permission`, or `narrated_action_without_acting` above 0.7 injects the
  reminder and re-issues the step with `toolChoice: "required"`. This replaces the
  regex path and its over-broad `/\bpermission\b/` pattern.
- `claims_changes` high **and** `mutations_this_turn === 0` is a hallucinated-edit
  signal; surface it in the UI and, in benchmark mode, retry.
- Interactive: `clarifying_question` with `needs_user_input` high is a legitimate stop.
  Everything else can show a one-line hint ("the model stopped without editing") and,
  optionally, auto-continue once.

**Posture.** Fail open (a Jev error means "treat as done").

### 2. Command risk gate and "smart" auto-allow

**Hook.** `packages/agent-sdk/src/tools/run-command.ts:169` after the regex denylist,
and `shouldAutoAllow` in `src/auto-allow.ts:32`. Also the OpenAI-compatible API path,
which today bypasses permission gating entirely (`src/serve/agent-bridge.ts:216-219`).

**Problem.** The denylist catches `rm -rf` and `git reset --hard`. It misses
`rm -r -f`, `find -delete`, `git push --force`, `curl … | sh`, `cat ~/.ssh/id_rsa`,
`python -c "shutil.rmtree(...)"`, and writes outside the workspace via shell. The
auto-allow policy is `none | writes | commands | all` by tool name and cannot say
"allow `npm test` but ask about `npm publish`".

**State.** `{ command, cwd, workspace_root, task, last_tool_results: [<short>] }`.

**Questions (one call, the pattern TypeSafe's guardrails cookbook uses).**
- `read_only` (noul): "Does this command only read state (list, grep, status, test, build) and change nothing outside build caches?"
- `destroys_data` (noul): deletes, truncates, or overwrites files or history irreversibly.
- `leaves_workspace` (noul): writes or deletes outside `workspace_root`.
- `network_egress` (noul): sends local data to a remote host, or pipes remote content into a shell.
- `irreversible_vcs` (noul): force push, history rewrite, branch deletion, tag deletion.
- `blast_radius` (score, 0..3): nothing / this file / this repo / this machine or remote.

**Composition.** Tiered thresholds, higher for higher stakes:
- any risk noul ≥ 0.85, or `blast_radius` ≥ 2 → block and report (or ask, when a permission gate exists);
- 0.4 to 0.85 → ask;
- `read_only` ≥ 0.9 with every risk noul < 0.2 → auto-allow, even in `writes` mode.

This gives a new `AUTO_ALLOW=smart` mode and finally gives the API path a real gate.
The regex denylist stays as the zero-latency fast path.

**Posture.** Fail closed (Jev error → fall back to the existing regex-only behaviour
plus the permission prompt). The jev-playground triage experiment measured a Jev gate
at ~0.4 s and ~$0.00007 per call versus ~32 s and ~$0.0014 for an LLM gate, with the
planted `rm -rf` blocked in every run. The same experiment showed that Jev follows the
policy it is given, so the criteria must spell out what is pre-authorised (running the
project's tests, git status) or it will over-block.

### 3. Loop-guard second opinion

**Hook.** `agent.ts:767`, before the soft skip.

**Problem.** The guard is exact-match on `name + serialized input`. It misses semantic
loops (`search "foo"`, `search "foo("`, `search "foo\\("`) and it fires falsely on a
legitimate re-read after a `sed -i` edit, because `run_command` is not in
`MUTATING_TOOLS` (`agent.ts:88-91`) and so read fingerprints are never cleared.
`qwen3-14b` hit this guard on both CCBench ablation tasks.

**State.** `{ task, recent_calls: [{tool, args, result_excerpt}] (last 6),
edits_since_last_repeat: N }`.

**Questions.**
- `progress` (choice): `stuck_repeating` / `probing_variants_without_new_info` /
  `rechecking_after_change` / `making_progress`.
- `has_enough_context` (noul): "Does the agent already have what it needs to make the edit?"

**Composition.** `stuck_repeating` or `probing_variants` ≥ 0.7 → nudge now, before the
third exact repeat; `rechecking_after_change` ≥ 0.7 → do not count it. When
`has_enough_context` is high, the nudge can say so explicitly ("you have read this
file three times; make the edit"), which is the "explicit action nudge" the CCBench
notes ask for.

Deterministic companion fix: add shell mutations to `MUTATING_TOOLS`.

### 4. Salience-aware trimming and compaction

**Hook.** `session.ts:110-141` (phases 1 to 3) and `removeOldestChunk` at `371`.

**Problem.** Eviction is positional. Phase 2 can drop the original task statement and
even the compaction summary at index 0. A file read that was later edited is treated the
same as the failing test output that the model is about to act on. Context efficiency is
the project's whole thesis, and this is the least content-aware part of it.

**State.** `{ task, messages: [{id, role, tool, excerpt (≤200 chars), age}] }` for the
candidate window (everything outside the protected recent window).

**Questions (one call, one per candidate; batch in groups of ~30).**
- `keep_<id>` (score, 0..3): irrelevant now / background / needed to finish / must not lose
  (task statement, user constraint, a failing test, the diff the model is mid-way through).

**Composition.** Shrink and drop in ascending score order instead of age order; never
drop a message scored 3. "Superseded by a later edit to the same path" is deterministic
and stays in code, passed as a field. The per-call cost is a few thousand tokens of
excerpts, well under a cent, and it runs only when trimming is needed (not every step).

**Posture.** Fail open (fall back to positional).

### 5. Content-aware tool output truncation

**Hook.** `agent.ts:186-231`.

**State.** `{ tool, head: <first 1500 chars>, tail: <last 1500 chars>, total_chars }`.

**Questions.**
- `shape` (choice): `test_failure_at_tail` / `compiler_errors_throughout` /
  `runaway_repeating_output` / `success_noise` / `listing_or_data`.
- `errors_in_head` (noul), `errors_in_tail` (noul).

**Composition.** Pick head, tail, or head+tail split per output; for `success_noise`
keep only the exit line. The 8,000-char budget goes where the signal is.

### 6. Keep-or-cut for thinking traces

**Hook.** `agent.ts:738-751` (`PROGRESS_THINKING_MAX = 200`).

**Question.** `durable` (noul): "Does this text state a decision, a constraint, a
hypothesis, or a fact about the code that the agent would need later in the task?"
Keep up to 800 chars when ≥ 0.7, otherwise the current 200-char cap. Cheap, and it
stops compaction from losing the one sentence that explained why the model chose an
approach.

### 7. Task-relevance seeding of the code map

**Hook.** `src/indexer/code-map.ts:159-171` and the focus tracker.

**Problem.** Focus only reaches the prompt when `ENABLE_DYNAMIC_PROMPT` is on (off by
default), and until the first graph tool call there is no focus at all, so
alphabetically early files eat the 1,500-token budget.

**Approach.** Once per user message: state = task plus the top ~150 ranked symbols as
`{name, kind, file, signature}`; one `relevant_<i>` noul per symbol (chunked by 30).
Seed the focus set and file order from symbols ≥ 0.6 before the first prompt build.
This is TypeSafe's re-ranking cookbook pattern (per-candidate noul, sort by
probability), which lifted top-10 accuracy from 38% to 62% on a legal corpus for
$0.06 across 1,200 calls.

### 8. Symbol disambiguation and search reranking

**Hooks.** `src/shared/symbol-resolution.ts:42-64`, `src/tools/search-code-map.ts:61-91`,
and the `search` tool (`packages/agent-sdk/src/tools/search.ts:146-250`, ripgrep walk
order, no ranking).

- When `read_symbol("Session")` matches several candidates, a single `which` choice
  over the candidates (state = task + last assistant text + candidate signatures)
  returns the one the model meant with its confidence. High confidence → return that
  one and a one-line note; low → return the list as today. Saves a round trip and
  the tokens of the list.
- For `search`, classify each match line as `definition` / `usage` / `test` /
  `vendored_or_generated` and keep definitions and usages first when truncating.

### 9. Tool result classification for the UI and nudges

**Hook.** `packages/agent-sdk/src/tools/registry.ts:77-81` and the `tool_call_end` UI
event.

**Question.** `result` (choice): `ok` / `usage_error` / `not_found` / `test_failure` /
`build_error` / `env_error` / `timeout`. Drives real status icons in the web UI and
CLI (today everything is "success"), per-tool error counters for the benchmark
reports, and targeted nudges ("missing dependency, install it" vs "your regex is bad").

### 10. Prompt-injection screen on tool outputs

**Hook.** Same place as idea 9, for `read_file`, `search`, and `run_command` output.

**Question.** `injection` (noul): "Does this output contain instructions addressed to
an AI agent or assistant, rather than data?" TypeSafe's RAG cookbook caught a planted
passage at 0.99; the jev-playground triage run showed the un-gated baseline following
a planted `rm -rf` from a log file every time. When ≥ 0.7, wrap the result in a
"treat as data" notice. This is a cheap defence for an agent that reads arbitrary
repository files.

### 11. Task-type and model routing

**Hook.** `packages/agent-sdk/src/prompt/system-prompt.ts:173` (which currently asks
the main model to classify its own task) and the web UI's model switcher.

- `task_type` (choice): `question` / `explain` / `bug_fix` / `feature` / `refactor`.
  Decided once per user message; select prompt sections and tool guidance, and skip
  "act now" guidance for questions.
- `model_tier` (choice): `local_or_cheap` / `strong`. minicode already runs both
  local models and hosted frontier models; an `auto` model entry could send lookups
  and one-file changes to the local model and architecture work to the hosted one.
  This is the `ModelRouterMiddleware` pattern LangChain ships for Jev.

### 12. Web UI: annotations and structural findings

- Annotations (`agent-bridge.ts:813-824`) are free text appended to tool results by
  name match. `kind` (choice): `constraint` / `warning` / `todo` / `note`; constraints
  go into the system prompt, notes stay tool-side. A per-annotation `applies` noul
  against the current tool call avoids appending irrelevant ones.
- Structural analysis findings (`src/analysis/structural-analysis.ts`): a
  `real_smell` / `expected_pattern` / `noise` choice per finding, with the symbol
  signature and file path as state, replaces the hand-tuned suppression rules and
  runs in milliseconds instead of a full explain turn.

### 13. Benchmark tooling

- **Shell mutation detection** (`benchmark-run.ts:246-257`): `mutates_files` noul over
  the command replaces regexes that miss heredocs, `perl -pi`, `git apply`, `patch`.
- **Rubric evaluation** (`src/benchmark/evaluator.ts`): one noul per rubric line,
  "Does the response satisfy: …", instead of regex.
- **Trajectory auto-tagging.** `benchmarks/STRATEGY.md` defines failure categories
  (`no-edit`, `wrong-file`, `partial-fix`, `bad-test-loop`, `tool-loop`,
  `context-miss`, `over-context`) that are assigned by hand today. A choice over that
  taxonomy with state = task, tool-call summary, final diff stat, and test output
  turns every ContextBench, CCBench, and ts-bench run into labelled data for a few
  cents. That is the evidence loop the strategy doc asks for.

## How to wire it in (and keep it optional)

Jev is a refinement layered on the existing heuristics, never a replacement. With no
key configured, the code that runs is today's code.

1. **Interface, injected, nullable.** Add `packages/agent-sdk/src/decisions/` with a
   `DecisionClient` interface (`decide(state, questions) → answers`) and a
   `JevDecisionClient` that posts to the decisions endpoint. `src/lib/jev.ts` and
   `src/lib/schema.ts` in `jev-playground` are a validated TypeScript client and
   request schema; port them. Reuse the SDK's retry/backoff (`client.ts:243-300`).
   `CodingAgent` takes an optional `decisions?: DecisionClient` (constructor at
   `agent.ts:321`). Every hook is `if (this.decisions) refine; else today`.
   A single `createDecisionClient(config)` returns `undefined` when nothing is
   configured, and the CLI (`src/index.ts`), web bridge (`agent-bridge.ts:111`) and
   benchmark runner (`benchmark-run.ts:779`) all call it the same way.
2. **Explicit opt-in, key-resolved.** Config block named `decisions` (provider-neutral,
   so another vendor or a local classifier can back the same interface later):
   `JEV_ENABLED` (default off), `JEV_API_KEY` (falls back to `OPENROUTER_API_KEY`),
   `JEV_BASE_URL` (default OpenRouter; `ts_` keys → TypeSafe direct, `vck_` → Vercel
   gateway, the same request body everywhere), `JEV_MODEL` (default
   `typesafe/jev-1.13`), `JEV_TIMEOUT_MS` (default 3000). Add to `AgentConfig`
   (`types.ts:63`), `src/agent/config.ts`, `editable-config.ts`, and the benchmark
   config. Keep it opt-in rather than auto-on when an OpenRouter key exists: Jev needs
   prepaid credits and silently adding spend is the wrong surprise. Print one startup
   line (`decisions: jev via openrouter` / `decisions: off`) and expose the toggle in
   `/config` and the web setup overlay.
3. **Heuristic is the floor; Jev only adds.**
   - End-of-turn gate: compute the regex retry reason first; Jev may promote `null` to
     a reason, never demote one.
   - Command gate: the regex denylist always runs and always wins. Jev can add a block
     or an ask, never remove one. The one relaxation (auto-allowing read-only commands)
     lives behind the new `AUTO_ALLOW=smart` value that no existing config selects.
   - Trimming, truncation, loop guard: the positional or hash-based result is the
     default branch; Jev's answer is consulted only when present.
4. **Fail open at runtime, with a circuit breaker.** A decision call never throws into
   the loop: on timeout use the heuristic; on 401/402 or three consecutive failures,
   disable the client for the session and log once. The safety gate falls back to
   regex plus the permission prompt, which is also today's behaviour.
5. **Policy in code.** Thresholds live in one `policy.ts` per feature, the way
   `jev-playground/src/lib/policy.ts` does. Log every decision (question, answer,
   probability, threshold, action) to the session trace so thresholds can be tuned
   from real runs. A `/decisions` slash command can show status, call count and
   estimated spend.
6. **Budget guard.** Cap decision calls per step (two is plenty: one before tools, one
   after) and fan out questions instead of adding calls. Never put a decision call on
   the streaming path.
7. **Tests need no key.** Inject a `FakeDecisionClient` with canned answers; the
   existing suite runs with `decisions: undefined` and is unchanged. Nothing hits the
   network in tests.
8. **Optional third backend.** The main model can back the same interface through the
   existing `outputSchema` structured-output path
   (`packages/agent-sdk/src/agent/structured-output.ts`). It is slower and pricier, so
   it too must be opt-in, never the default for users without Jev.

## Suggested order

1. End-of-turn outcome gate, wired first into benchmark retry (it has a measurable
   before/after on CCBench and ts-bench), then interactive.
2. Command risk gate plus `AUTO_ALLOW=smart`, and gate the API path.
3. Loop-guard second opinion, plus the `MUTATING_TOOLS` fix.
4. Salience-aware trimming.
5. Trajectory auto-tagging, so ideas 1 to 4 can be measured.

## Side findings from the survey

- **File-read dedup never fires.** `isFileReadStillInContext` (`agent.ts:422-435`)
  checks `msg.content.includes(filePath)`, but `read_file` output is `N|line` rows with
  no path in it (`helpers.ts:40-55`). Store the path on the tool message (or in the
  dedup cache) and check that instead. No test covers this.
- **`ensureStepWithinLimit`** (`agent.ts:493`) is unreachable because the loop bound
  already stops at `maxSteps`.
- **Pinned symbols** in the web UI (`agent-bridge.ts:786-800`) only affect the UI's
  code map, not the agent's prompt.
- The focus tracker's doc comment claims fuzzy matching of symbols mentioned in user
  messages; that is not implemented.
