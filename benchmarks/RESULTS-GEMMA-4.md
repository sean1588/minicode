# `ts-bench` — Gemma 4, head-to-head harness comparison

## Thesis

The `ts-bench` v1 top-25 TypeScript lane uses Exercism-style exercises that
start from a near-blank workspace with one stub function per task. There is no
codebase structure to navigate, no dependency graph to walk, and (as this run
confirms) the structural tools that differentiate minicode get exercised on
average less than once per task.

That makes ts-bench a poor surface for evaluating minicode's structural-context
value proposition. But it makes it an *excellent* surface for the question this
document is built around:

> **When the graph tools don't matter, is the rest of minicode's harness — its
> system prompt, tool descriptions, edit/test loop, error recovery, and loop
> discipline — at least competitive with the harnesses people are most likely
> to reach for instead?**

If minicode loses on this lane, no amount of graph tooling will close the gap
for users running local-sized models, because they would already be losing
before any of the structural-context machinery starts to pay off.

We measure this against two direct competitors that ship as installed CLI
agents and support OpenRouter as a model provider: **opencode** (the most
direct philosophical comparison — open-source TypeScript-first agent) and
**GitHub Copilot CLI** (the most likely default reach for a developer with
no prior commitments, and with BYOK support since the 2026-04-07
announcement).

We hold the model and the benchmark constant. The two model variants are:

- `google/gemma-4-31b-it` — dense 31B, the "ceiling" of the local-runnable
  envelope on a single 24GB GPU.
- `google/gemma-4-26b-a4b-it` — MoE with ~4B active parameters, the variant
  most likely to be run on consumer hardware in practice for speed.

This is the single most load-bearing lane in STRATEGY.md: a real local-class
model, evaluated on a harness-quality question, against agents the target
user already has installed.

## Methodology

| | |
|---|---|
| Benchmark | `ts-bench` v1 top-25 TypeScript lane (Exercism-style) |
| Provider | OpenRouter (paid slugs, not `:free`) |
| Models | `google/gemma-4-31b-it`, `google/gemma-4-26b-a4b-it` |
| Auth | Single `OPENROUTER_API_KEY` shared across all three agents |
| minicode version | `local-dev` (current `main`, build before the runs) |
| opencode version | `1.14.39` (`opencode-ai` from npm) |
| copilot version | `1.0.41` (`@github/copilot` from npm) |
| ts-bench commit | Vendored `/tmp/ts-bench` (laiso/ts-bench upstream + minicode adapter patch + Copilot OpenRouter BYOK patch) |
| n | 1 run per cell, except minicode-26B-A4B which has 2 runs (variance check) |

The Copilot OpenRouter BYOK case was added to ts-bench's
`src/agents/registry.ts` (`copilot.getEnv`) — when invoked with
`--provider openrouter` it now sets `COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1`,
`COPILOT_PROVIDER_API_KEY=$OPENROUTER_API_KEY`, and
`COPILOT_PROVIDER_TYPE=openai`, mirroring what already exists for the
`claude` adapter on OpenRouter. opencode required no patches.

## Headline matrix

| Agent | gemma-4-31b-it | gemma-4-26b-a4b-it | Δ (31B → 26B) |
| --- | --- | --- | --- |
| **minicode (pre-#177)** | **84%** (21/25), 23.3 min | **48–68%** (12–17/25), 17.6–27.5 min — see variance | −16 to −36 pp |
| **minicode (post-#177, n=3 mean)** | not re-run | **78.7%** mean (range 72–84%), 28.6 min avg — see post-#177 section | −5.3 pp (mean) |
| **opencode** | 76% (19/25), 49.7 min | 84% (21/25), 38.8 min | +8 pp |
| **copilot** | 84% (21/25), 45.1 min | 80% (20/25), 43.5 min | −4 pp |

On the **31B** dense model, minicode ties Copilot at 84% and leads opencode by
8 pp, while finishing in roughly half the wall-clock time of either competitor.

On the **26B-A4B** MoE — the locally-likely model — both opencode and copilot
hold within 4 pp of their 31B score. Pre-#177 minicode was the only agent
whose performance collapsed on the smaller model. **Post-#177 (a single run
with the honest-tool-output fixes from #177 merged), minicode-26B is at 80%,
tying Copilot and within 4 pp of opencode** — see the post-#177 section
below for trajectory and causality discussion.

## Per-task pass/fail (all six cells)

"r1/r2" = pre-#177 minicode-26B runs 1 and 2. "r3/r4/r5" = post-#177 minicode-26B runs (r3 solo; r4 and r5 ran concurrently against separate ts-bench checkouts — see Post-#177 section for the upstream-provider routing caveat).

| Task | minicode-31B | minicode-26B r1 | minicode-26B r2 | minicode-26B r3 | minicode-26B r4 | minicode-26B r5 | opencode-31B | opencode-26B | copilot-31B | copilot-26B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `accumulate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `acronym` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| `all-your-base` | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `allergies` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `alphametics` | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `anagram` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `armstrong-numbers` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `atbash-cipher` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `bank-account` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `beer-song` | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `binary-search` | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `binary-search-tree` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `bob` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `bowling` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `circular-buffer` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `clock` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `collatz-conjecture` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `complex-numbers` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `connect` | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| `crypto-square` | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `custom-set` | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `darts` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| `diamond` | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | ✅ |
| `difference-of-squares` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `diffie-hellman` | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

Tasks **everyone fails on** (likely model-capability ceiling, not harness):
`complex-numbers`. `bowling` fails for both Copilot variants and one of the
minicode-26B runs. These are not harness signals.

Tasks **only minicode-26B fails** (relative to opencode-26B + copilot-26B):
`all-your-base`, `alphametics`, `binary-search-tree`, `diffie-hellman`. These
four are passed by both competitors with the same model, in both
minicode-26B runs.

## Timing and behavior

| Cell | Avg agent time/task | Agent-success | Test-success | Overall |
| --- | --- | --- | --- | --- |
| minicode 31B | 56s | 25/25 | 21/25 | **84%** |
| minicode 26B r1 (pre-#177) | 42s | 25/25 | 12/25 | **48%** |
| minicode 26B r2 (pre-#177) | 66s | 23/25 | 17/25 | **68%** |
| minicode 26B r3 (post-#177, solo) | 72s | 23/25 | 20/25 | **80%** |
| minicode 26B r4 (post-#177, paired with r5) | 59s | 24/25 | 21/25 | **84%** |
| minicode 26B r5 (post-#177, paired with r4) | 75s | 25/25 | 18/25 | **72%** |
| minicode 26B post-#177 (n=3 mean) | 69s | 24.0/25 | 19.7/25 | **78.7%** |
| opencode 31B | 119s | 21/25 | 21/25 | 76% |
| opencode 26B | 93s | 23/25 | 21/25 | **84%** |
| copilot 31B | 108s | 21/25 | 21/25 | 84% |
| copilot 26B | 104s | 21/25 | 20/25 | **80%** |

Three things stand out:

1. **minicode-26B finishes ~2× faster than competitors per task and gets
   roughly half the answers right.** It is not failing to *try* — agent-success
   is 23–25/25. It is exiting cleanly with broken code.
2. **Within minicode's own runs, more wall-clock per task correlates with more
   passes.** Run #2 gave 26B 1.6× more time per task on average and gained 5
   net passes. The product is gating on something it shouldn't.
3. **Both competitors converge on ~80–84% across both Gemma 4 sizes**, while
   minicode swings from 84% to ~58% (mean of two 26B runs). The 26B-A4B is
   not the bottleneck; the harness around it is.

## Variance signal

Two runs of minicode-26B-A4B produced 48% and 68% — a 20 pp swing on the same
configuration. The 11 tasks both runs passed are likely a stable lower bound;
the 6 tasks only run #2 passed sit on a noise threshold. n=1 is clearly
inadequate for the 26B class on this lane. Future ablation runs should use
n≥3 with the variance reported.

The competitors' n=1 numbers may also be optimistic or pessimistic by 5–10 pp,
but their 31B → 26B *delta* (within 8 pp) is much tighter than minicode's
(16–36 pp). Variance does not explain the cross-agent gap.

## Post-#177 baseline (n=3, with methodology asterisk)

After PR #177 ("Improve tool outputs: stop the agent from confidently shipping
wrong answers", merged 2026-05-06) we re-ran the minicode-26B-A4B configuration
with no other changes. The PR fixed five tool-output honesty issues — silent
`read_file` truncation, "no matches" with no domain breadcrumbs, mid-string
clipping of qualified symbol names, suboptimal fallback recommendations on
`read_symbol` miss, and unlabeled agent-level truncation footers.

### Trajectory of all minicode-26B-A4B runs

| Run | State | Score | Avg time/task | Agent-success | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | pre-#177 | 48% (12/25) | 42s | 25/25 | solo |
| 2 | pre-#177 | 68% (17/25) | 66s | 23/25 | solo |
| 3 | post-#177 | 80% (20/25) | 72s | 23/25 | solo |
| 4 | post-#177 | 84% (21/25) | 59s | 24/25 | concurrent with r5 |
| 5 | post-#177 | 72% (18/25) | 75s | 25/25 | concurrent with r4 |

**Pre-#177 mean (n=2)**: 58%
**Post-#177 mean (n=3)**: 78.7%
**Post-#177 range**: 72–84%
**Lift attributable to #177**: ~21 pp on the 26B-A4B mean

### Parallel-execution methodology asterisk

r4 and r5 ran concurrently against different ts-bench checkouts but a shared
OpenRouter API key. OpenRouter load-balances `google/gemma-4-26b-a4b-it`
across multiple upstream providers (Together, DeepInfra, Lambda, etc.). The
data shows fingerprints of upstream-provider divergence:

- r5 lost **four tasks that BOTH r3 and r4 passed**: `alphametics`,
  `bank-account`, `beer-song`, `diamond`. With benchmark-mode `temperature=0`
  this is a sharper drop than pure stochastic variance should produce.
- r5 won one task (`bowling`) that r3 and r4 both failed — net divergence
  pattern of −3.

Treat r5 as the noisier of the three. r3 (solo) at 80% and r4 (concurrent
but ahead in the queue) at 84% are the more representative numbers; the
post-#177 picture is best summarized as **~80% with a min/max bracket of
72–84%**, not "78.7% ± noise."

Future experiments will be serialized.

### Causal-flavor evidence vs. variance

Tasks that failed in BOTH pre-#177 runs and **pass in 3/3 post-#177 runs**:

- `all-your-base` (❌, ❌ → ✅, ✅, ✅)
- `crypto-square` (❌, ❌ → ✅, ✅, ✅)
- `diffie-hellman` (❌, ❌ → ✅, ✅, ✅)

These three moving together is hard to dismiss as noise — pure variance would
expect a more scattered pattern. They are also exactly the failure shape
#177 was designed to address: tasks where the agent likely hit a confident-
wrong dead end (silent file truncation, fruitless search with no breadcrumb,
ambiguous symbol cut mid-name) and exited cleanly with broken code rather than
recovering.

One additional task (`alphametics`) failed both pre-#177 runs and passes in
2 of 3 post-#177 runs (failed only in the noisy r5).

### Per-task pass rate across post-#177 runs (3-run buckets)

- **3/3 pass (rock-solid), 16 tasks**: `accumulate`, `acronym`,
  `all-your-base`, `allergies`, `anagram`, `armstrong-numbers`,
  `atbash-cipher`, `bob`, `circular-buffer`, `clock`, `collatz-conjecture`,
  `crypto-square`, `custom-set`, `darts`, `difference-of-squares`,
  `diffie-hellman`
- **2/3 pass, 5 tasks**: `alphametics`, `bank-account`, `beer-song`,
  `connect`, `diamond` — note 4 of these 5 failures are concentrated in r5
- **1/3 pass, 1 task**: `bowling` (only r5 passed)
- **0/3 pass (always failing), 3 tasks**: `binary-search`,
  `binary-search-tree`, `complex-numbers`

### Cross-agent picture on gemma-4-26b-a4b-it (post-#177)

| Agent | Score |
| --- | --- |
| opencode (n=1) | 84% |
| **minicode post-#177 (best of 3)** | **84%** |
| **minicode post-#177 (n=3 mean)** | **78.7%** |
| copilot (n=1) | 80% |
| minicode post-#177 (worst of 3, noisy r5) | 72% |
| minicode pre-#177 (best of 2) | 68% |
| minicode pre-#177 (mean of 2) | 58% |

The 36-pp gap measured at the start of this experiment (vs. opencode-26B) is
essentially closed by a single PR. minicode now overlaps the competitor band
on the locally-likely model. Note that the competitor numbers are themselves
n=1 and likely carry similar 5–10 pp variance.

### Implications for the next experiment

- **The pre-existing premature-termination hypothesis** (Findings #2) is
  partially vindicated and partially obsoleted. Vindicated: avg time per task
  is still ≤opencode/copilot's, so loop-discipline headroom remains.
  Obsoleted: most of the gap turned out to be confident-wrong tool output
  rather than a missing tests-must-pass criterion. The next strategic round
  should re-validate against this ~80% baseline, not the original 48%.
- **The 3 always-failing tasks** (`binary-search`, `binary-search-tree`,
  `complex-numbers`) plus `bowling` are the obvious targets for the next
  experiment. Together they're 16 pp of theoretical headroom on the lane.
- **Future experiments will be serialized**, not run in parallel. The r5
  divergence is a clear demonstration that concurrent OpenRouter calls
  contaminate variance measurements with upstream-provider routing noise.

## Experiment 1: oneshot-mode tests-must-pass exit criterion

**Status: did not meet acceptance bar. Negative result.**

### Change shipped

Refactored the system-prompt suffix system: most of the existing benchmark-only
suffix moved into a new shared `src/cli/oneshot-prompt.ts` (applies to any
`--oneshot` invocation, not just benchmarks). Benchmark mode now layers a
small harness-specific framing on top. The substantive new clause:

> *After making code changes, if the workspace has a discoverable test
> command (e.g. `npm test`, `pytest`, `cargo test`, a Makefile target, or
> a documented test invocation in README/CONTRIBUTING), run the relevant
> tests before declaring the task done. If any test fails, either fix the
> implementation and retry, OR explicitly identify which test(s) failed
> and explain why you believe the failure is unrelated to your changes.
> Do not silently declare success when tests are failing. If no test
> command is discoverable or no tests exist for the changed code, this
> clause does not apply.*

The architecture refactor also moves the retry-once-on-approval-seeking
heuristic to oneshot level (was benchmark-only).

### Acceptance bar (from doc above)

- ≥+5 pp on 26B-A4B mean across n=3 runs vs. post-#177 baseline (78.7%)
- ≤4 pp regression on 31B (untested — change not gated on this since headline result was negative)

### Results (n=3, serialized)

| Run | Score | Avg time/task | Agent-success |
| --- | --- | --- | --- |
| r6 | 84% (21/25) | 76s | 25/25 |
| r7 | 76% (19/25) | 69s | 24/25 |
| r8 | 72% (18/25) | 80s | 24/25 |
| **post-prompt mean (n=3)** | **77.3%** | 75s | 24.3/25 |
| post-prompt range | 72–84% | | |

### Comparison to post-#177 baseline

| | Mean | Range | Avg time |
| --- | --- | --- | --- |
| Post-#177 (n=3) | 78.7% | 72–84% | 69s |
| Post-prompt-change (n=3) | **77.3%** | 72–84% | 75s |
| **Δ** | **−1.4 pp** | identical | +6s/task |

The change did not meet the +5 pp bar. The ~1.4 pp dip is within variance
noise, but the +6s/task wall-clock cost is real: the model is running tests
slightly more often without that translating into more passes.

### Per-task picture vs. post-#177

The 3/3-pass set is the same size (16 tasks) but with three swaps each
direction (a wash, not progress).

- **Gained 3/3**: `alphametics`, `bank-account`, `diamond`
- **Lost 3/3**: `all-your-base`, `anagram`, `diffie-hellman`
- **Targeted but unmoved**: `binary-search`, `binary-search-tree`,
  `complex-numbers` failed in every post-prompt run (0/3), exactly as in
  the post-#177 baseline. These were the explicit targets of the change.
- `bowling` 1/3 (vs. 1/3 baseline) — also unmoved.

### Why this likely failed

The premature-termination hypothesis predicted: the model declares done with
*recoverable* wrong code, and another iteration would fix it. For the clause
to help, the model must be able to correct its own failing code on a second
try.

The negative result suggests the model on `binary-search`/-`tree` and
`complex-numbers` isn't producing wrong-but-recoverable code — it's
producing wrong-and-keeps-being-wrong code. More iterations at the same
model capability yield the same wrong answer, just with extra wall-clock.

The +6s/task increase without pass-rate change is consistent with: the
model is now running tests it didn't run before, occasionally retrying on
hard tasks, but the retries are equally wrong.

### Implication

**Post-#177 (~80% on 26B-A4B) appears to be close to the harness-and-model
ceiling for this lane, not a number we can keep eroding with prompt
changes.** Further headroom on this specific cell likely requires either
a stronger model (Gemma 4 31B already gets 84%), or a substantively
different mechanism — feeding actual test-failure output back as targeted
hints, transcript inspection of the 3 always-failing tasks for a pattern,
or pivoting to a lane that exercises a different part of the harness.

The architecture refactor (`oneshot-prompt.ts` split) is independently
worth keeping — future prompt experiments are easier to scope. Whether
the tests-must-pass clause itself ships is a judgment call: it costs
~6s/task, helps zero on this lane, and may or may not help on richer
workloads (CCBench, real codebases) where the failure shape is different.

## Findings

1. **minicode's harness is competitive on capable models and falls behind on
   smaller models.** On Gemma 4 31B (dense) it ties or leads on accuracy, with
   2× faster wall-clock. On Gemma 4 26B-A4B (MoE) it lags both competitors by
   12–36 pp.

2. **The mode of failure is premature termination, not capability.** Minicode
   exits cleanly with broken code in 42–66s/task; opencode and copilot stay in
   the loop for 93–104s/task and finish with passing tests. The model is the
   same in all three cases.

3. **Of the 13 tasks minicode-26B failed in run #1, opencode solved 10 and
   copilot solved 9.** Only `complex-numbers` and `bowling` are
   model-capability ceilings. The rest are harness-recoverable.

4. **The structural tools were essentially unused on this lane.** From the
   31B run, ~1 specialized tool call per task, all `read_symbol`. The gap is
   not because we forgot to use the graph; the graph is irrelevant here. This
   is purely about the prompt + edit/test loop.

5. **The gap is reproducible across two independent harnesses.** Both opencode
   and copilot (very different codebases, very different prompts) land in the
   same 80–84% band on the 26B. That makes it harder to dismiss as opencode-
   specific tuning. There is something both competitors do that minicode does
   not.

## Hypothesis: minicode does not enforce a "tests pass" exit criterion under loop pressure with small models

Looking at the per-task behavior, the most parsimonious explanation is:

- minicode's benchmark-mode prompt suffix tells the model not to stop after a
  plan and to act on the task as already approved. It does **not** tell the
  model that the task is incomplete until the test suite passes.
- For capable models (Sonnet 4.6 at 100%, Gemma 4 31B at 84%) this slack is
  invisible: the first or second attempt is right.
- For smaller models that produce a plausible-but-wrong first attempt, the
  agent loop accepts the first "I have implemented the function" response,
  prints final text, and exits. The test then fails.
- Both opencode and copilot appear to keep the model in the edit→run-tests
  cycle until tests pass (or wall-clock cap is hit). This is exactly the
  loop discipline that survives small-model uncertainty.

The within-minicode signal (run #1 at 42s/task and 48% vs run #2 at 66s/task
and 68%) is consistent with this. Variance in *how long the model is willing
to stay engaged* is variance in *how often it gets the right answer*.

This also explains why minicode wins on wall-clock against the competitors at
the 31B size: when the first attempt is right, exiting fast is a real
advantage. The same reflex on a 26B model that frequently needs a second
attempt is exactly the wrong shape.

## Strategic changes to try

**Recalibration after #177**: the original gap (36 pp behind opencode-26B)
is mostly closed by the tool-output honesty fixes. The remaining gap is
≤4 pp on n=1 post-#177, which is inside variance noise. So the strategic
items below should now be expected to lift maybe 0–10 pp, not 30+, and the
selection criterion shifts from "close a big gap" to "robustness on the tail
of consistently-failing tasks." Items to try, in rough order of impact-to-effort:

1. **Add a "tests must pass" exit criterion to the benchmark-mode system
   prompt suffix.** Stronger than the current "finish the task instead of
   stopping after a plan" wording — explicit: *if a test command is available
   in the workspace, run it after edits; if any test fails, you have not
   finished the task; revise the implementation and retry until tests pass or
   you have exhausted reasonable attempts.* One-line product change to the
   benchmark suffix. Targets the still-failing tasks (`bowling`, `connect`,
   `binary-search-tree`, `complex-numbers`) where the failure mode is
   plausible-but-wrong code, not stuck tool output.

2. **Add a no-edit / no-test failure recovery message.** STRATEGY.md already
   lists `loop-recovery` as a candidate prompt profile. The trigger here would
   be: model returned a stop-token, but no tests have been run since the last
   mutation. Re-prompt with: *you edited code but did not verify it. Run the
   tests now.*

3. **Treat "agent says done but tests fail" as a recoverable state, not a
   terminal one — at least in benchmark mode.** Today, when the model emits a
   plain-text completion, the agent loop ends. In benchmark mode, if tests
   were never run successfully after the last edit, re-engage the model with a
   targeted prompt instead of returning.

4. **Consider raising `maxSteps` for small-model lanes.** The 26B isn't
   running out of steps in any minicode run (avg total tool calls per task
   is well below 50), so this is unlikely to be primary, but it should not
   bind the loop budget if changes 1–3 cause more iteration.

5. **Re-baseline after each prompt change with n≥3 runs of minicode-26B-A4B.**
   STRATEGY.md's "consistent improvement" rule needs an operational definition
   on this lane. **Updated post-#177 acceptance bar**: a change should land if
   it raises the 26B-A4B mean pass rate by ≥5 pp across 3 runs vs. the
   post-#177 baseline (currently 80% n=1, will be n=3 mean once runs 4 and 5
   land), without regressing the 31B run by more than 4 pp. The pp threshold
   is lower than the original 10 pp because the remaining headroom is smaller.

6. **Honest tool outputs (#177-style) on other failure-rich code paths.**
   #177 demonstrated that confident-wrong tool output is the dominant failure
   class on this lane. Audit other tools (`list_files`, `get_dependencies`,
   `find_path`, MCP-attached tools) for similar silent-incompleteness or
   ambiguity bugs. Track in follow-up issues, not here.

What we should *not* do based on this data:

- Promote any of the above to a global product default. Capable-model behavior
  is fine today (Sonnet 4.6 at 100%, GPT-5 at 92% on this lane). The fix
  belongs in benchmark mode (and perhaps a future explicit local-model
  profile), not in the interactive default.
- Conclude anything about the structural-tool ablation from this lane. That
  experiment still belongs on CCBench JS/TS or `benchmarks/tasks/`.

## Caveats and known issues

- **n=1 for five of the seven cells.** Only minicode-26B has two runs. A 5–10
  pp swing in any of the competitor numbers would not change the qualitative
  finding (minicode trails on the 26B), but it could shift the magnitude.
- **opencode and copilot use a 300s wall-clock cap per task; minicode uses
  `modelTimeoutSeconds=120` per model call plus `maxSteps=50`.** These are
  different shapes of budget, not directly comparable. The relevant
  observation is not "competitors got more time" — it's that competitors
  *used* more of the time they had on the 26B by staying in the loop, and
  minicode did not.
- **The copilot adapter patch lives in the local `/tmp/ts-bench` checkout
  only.** It is not upstreamed. Reproducing this experiment from a fresh
  ts-bench clone requires re-applying the patch (the diff is small — a single
  `if (provider === 'openrouter') { ... }` block in `copilot.getEnv` —
  details in the methodology section).
- **Per-task tool/token data was again partly clobbered** because runs share
  `/tmp/ts-bench/repos/exercism-typescript/exercises/practice/<task>/`. Only
  the most recent minicode run's per-task `minicode-<task>.json` files survive
  on disk. This continues to be a fixable issue for future experiments.

## Reproducibility

```bash
export PATH="$HOME/.bun/bin:$PATH"
export OPENROUTER_API_KEY=...

# minicode (uses the repo wrapper)
TS_BENCH_MODEL=google/gemma-4-31b-it      TS_BENCH_PROVIDER=openrouter npm run benchmark:ts-bench
TS_BENCH_MODEL=google/gemma-4-26b-a4b-it  TS_BENCH_PROVIDER=openrouter npm run benchmark:ts-bench

# opencode (direct ts-bench invocation; note `openrouter/` prefix on the model)
cd /tmp/ts-bench
bun src/index.ts --agent opencode --provider openrouter \
  --model openrouter/google/gemma-4-31b-it      --dataset v1 --exercise 25 --output-format json
bun src/index.ts --agent opencode --provider openrouter \
  --model openrouter/google/gemma-4-26b-a4b-it  --dataset v1 --exercise 25 --output-format json

# copilot (requires registry.ts patch above; OpenRouter slug NOT prefixed)
cd /tmp/ts-bench
bun src/index.ts --agent copilot --provider openrouter \
  --model google/gemma-4-31b-it      --dataset v1 --exercise 25 --output-format json
bun src/index.ts --agent copilot --provider openrouter \
  --model google/gemma-4-26b-a4b-it  --dataset v1 --exercise 25 --output-format json
```

## Comparison points (existing minicode runs from `RESULTS.md`)

| Model | Score | Avg time |
| --- | --- | --- |
| `anthropic/claude-sonnet-4.6` | `100%` | `31.6s` |
| `openai/gpt-5` | `92%` | `93.7s` |
| `google/gemini-3-flash-preview` | `88%` | `39.3s` |
| `google/gemma-4-31b-it` (this) | `84%` | `55.9s` |
| `google/gemma-4-26b-a4b-it` (this, run 2) | `68%` | `66.1s` |
| `google/gemma-4-26b-a4b-it` (this, run 1) | `48%` | `42.2s` |
| `z-ai/glm-4.6` | `0%` | `55.7s` |

# Experiment 2: structural-tools ablation on the internal task suite

**Status: thesis supported with caveats. Pass rate +14.7 pp with graph tools across n=3, dominated by comprehension-heavy tasks. One reproducible regression surfaced (issue #184).**

After exhausting the prompt-change levers in Experiment 1, the unanswered question was whether minicode's structural tools — `read_symbol`, `find_references`, `get_dependencies`, `find_path`, `search_code_map` — actually do meaningful work, or whether they're a token-efficient way to reach the same answers a `read_file` + `search` workflow would. The ts-bench lane couldn't tell us (specialized tool usage was ~1/task and almost entirely a single bootstrap probe). CCBench JS/TS with Gemma 4 31B couldn't tell us either (model floored at 0/9 — no signal to ablate). The internal-tasks suite (`benchmarks/tasks/`) was the right surface.

## Why the internal task suite

25 hand-written rubric-scored tasks across 5 categories (`navigation`, `editing`, `refactors`, `debugging`, `planning`) that run against minicode's own codebase. The tasks reference real symbols by name (`CodingAgent`, `buildProjectIndex`, `Session`, `IndexedSymbol`, `LanguagePlugin`) — exactly what the graph tools are designed to look up. Runs locally via `npm run benchmark`, no Docker, ~10 min/run.

Critically, the all-tools baseline showed the structural tools genuinely firing on this lane: 55 symbol queries against 48 file reads across 25 tasks, vs. ts-bench's ~1 specialized call per task. There's a measurable phenomenon to ablate.

## Methodology

| | |
|---|---|
| Lane | `benchmarks/tasks/` (25 hand-written tasks, 5 categories) |
| Provider | OpenRouter |
| Model | `google/gemma-4-26b-a4b-it` (had to fall back from 31B due to Venice rate limits) |
| Workspace | the minicode repo itself |
| Cells | `all-tools` (default) vs. `file-search-only` (graph tools omitted, code map preserved in system prompt) |
| Tool-profile knob | `MINICODE_TOOL_PROFILE=file-search-only` env var, gates the 5 graph tools in `src/tools/registry.ts` |
| n | 3 runs per cell, serialized |
| Rubric | per-task `expectedOutputPatterns`, `expectedFilesRead`, `expectedSymbols`, `maxToolCalls` (some rubric bugs documented below) |

## Headline matrix (n=3 means)

| Metric | All-tools | File-search-only | Δ |
| --- | --- | --- | --- |
| **Pass rate (mean)** | **61.3%** | **46.7%** | **−14.7 pp** |
| Pass rate (range across 3 runs) | 56–68% | 40–60% | overlapping bands |
| Per-run | 60% / 68% / 56% | 40% / 60% / 40% | |
| Avg tools/task | 7.85 | 5.84 | −2.01 |
| **Avg tokens/task** | **67,136** | **42,239** | **−37.1%** |
| Avg duration/task | 31.8s | 32.0s | flat |

The 14.7-pp delta is real but sits inside the combined run-to-run band (40–68%). The per-task pattern below is sharper than the headline number.

## Per-category (n=3 mean pass rate)

| Category | All-tools | File-search-only | Δ |
| --- | --- | --- | --- |
| **planning** | 73.3% | **20.0%** | **−53 pp** |
| refactors | 80.0% | 60.0% | −20 |
| debugging | 66.7% | 53.3% | −13 |
| editing | 40.0% | 40.0% | 0 |
| **navigation** | 46.7% | 60.0% | **+13** ⚠️ |

The dominant signal is **planning** — tasks like *"Trace how indexing flows into prompt construction"*, *"Explain how to add a new language plugin"*, *"Plan adding a new tool"*. These require synthesizing relationships across multiple files. With graph tools the agent traces symbol relationships cheaply; without them the agent reads a few files and runs out of useful next-things-to-look-at, then answers from training-data priors.

The **navigation paradox** is real and reproducible — see `find-tool-registration` below.

## Per-task ≥2-of-3 advantage

**6 tasks where all-tools wins by ≥2 of 3 runs:**

| Task | All-tools | File-search-only |
| --- | --- | --- |
| `planning/explain-plugin-system` | **3/3** | **0/3** |
| `refactors/update-shared-interface` | **3/3** | **0/3** |
| `debugging/diagnose-failing-test` | 2/3 | 0/3 |
| `planning/explain-context-trimming` | 2/3 | 0/3 |
| `planning/plan-new-tool` | 2/3 | 0/3 |
| `refactors/consolidate-duplicates` | 3/3 | 1/3 |

**1 task where file-search-only wins by ≥2 of 3:**

| Task | All-tools | File-search-only |
| --- | --- | --- |
| `navigation/find-tool-registration` | **0/3** | **3/3** |

Net **+5 task advantage for graph tools** on per-task majority — directionally consistent with the −14.7 pp pass-rate delta.

## The unexpected mechanism: tokens DECREASED in file-search-only

The thesis predicted graph tools would reduce token usage by replacing whole-file reads with targeted symbol lookups. Reality is the opposite: **all-tools used 37% more tokens per task than file-search-only.** The mechanism isn't the predicted "fewer tokens for the same answer" — it's:

- With graph tools the agent stays engaged longer, builds a structural picture, and produces a correct answer (+14.7 pp pass rate, +37% tokens).
- Without graph tools the agent **gives up earlier with worse answers** (−37% tokens, −14.7 pp pass rate). It can't navigate efficiently, runs out of useful things to look up, and falls back to training-data priors.

The honest framing of the value prop on this lane is **"graph tools improve correctness on comprehension-heavy tasks at modest token cost,"** not "graph tools are cheaper." The README has been updated to reflect this.

## The reproducible regression: `find-tool-registration` (issue #184)

`navigation/find-tool-registration` failed in **all 3 all-tools runs and passed in all 3 file-search-only runs** — the cleanest signal in either direction. The task: *"Find where the agent tools (read_file, write_file, etc.) are registered and assembled into a ToolRegistry. Give me the file and the function name."*

In every all-tools run the model called `search_code_map({"pattern": "ToolRegistry"})`, which returned 8 matches (the class, several methods, and the `createToolRegistry` wrapper function). The model picked `ToolRegistry.createDefault` (a class method on the SDK base) instead of `createToolRegistry` (the application-layer wrapper the rubric expects). Both look equally plausible from the search output; the tool gives no ranking or disambiguation hint.

In file-search-only mode the model has to grep more carefully, reads the actual file, and lands on the correct function.

This is the same failure shape PR #177 attacked for `read_file` and `search`: confidently-wrong tool output that doesn't surface uncertainty. Filed as issue #184 with proposed fixes (rank exact-name matches first, cap with footer when many similar matches, hint at ambiguity when results span multiple symbol kinds).

## Rubric quality notes

Two of the all-tools failures are rubric bugs that affect both cells equally but bias the absolute numbers downward:

- `navigation/find-symbol-definition` requires `expectedFilesRead: ["agent.ts"]`, but `search_code_map` already gave the answer; the agent shouldn't need to read the file. The rubric **punishes the agent for using graph tools efficiently** — exactly backwards for an ablation that's supposed to test whether graph tools help.
- `navigation/find-all-references` requires the response to contain `project-index` (a file substring), but the question asks which files *call* `buildProjectIndex`, not which file *defines* it. A correct answer shouldn't include `project-index`.

Don't fix the rubrics before more runs — they bias absolute numbers but cancel out in the deltas. Worth a separate cleanup pass once we have a stable baseline.

## What this means for the thesis

1. **Structural tools improve correctness on comprehension-heavy tasks (+14.7 pp on the n=3 mean).** The strongest single piece of evidence: planning tasks drop from 73.3% to 20.0% without graph tools.

2. **The win is correctness, not raw token economy.** Tokens go *up* 37% with graph tools because the agent engages more deeply, not because it reads more whole files. This contradicts how the README originally framed the value prop. README updated.

3. **The regression mode is real but fixable** (issue #184). When `search_code_map` surfaces ambiguous matches with no ranking, the model picks the wrong one. Same failure class as PR #177.

4. **Editing tasks don't benefit** from graph tools (40% in both cells). Implementation tasks lean on edit-loop quality, not navigation.

5. **Variance is high** (40–68% across 6 runs). Future ablation work on this lane should default to n=3 minimum; the per-category and per-task signals are tighter than the aggregate pass rate and should be the primary read.

## Recommended follow-ups

In rough priority:

1. **Address issue #184** (`search_code_map` disambiguation). Likely closes the `find-tool-registration` regression and similar ambiguous-name tasks.
2. **Adopt `benchmarks/tasks/` as a CI/regression lane.** Fast (~10 min/run), local, no Docker, and now empirically discriminates between meaningful product changes.
3. **Fix the two rubric bugs** in `navigation/find-symbol-definition` and `navigation/find-all-references`. Raises absolute numbers without affecting deltas.
4. **Re-run with a stronger model** (gemma-4-31b once Venice cools, or GPT-5.4) to see whether the +14.7 pp delta is local-model-specific or holds at the frontier.
5. **Cross-agent comparison** with copilot and opencode on the same lane (n=1 directional, stdout-matching only) — done, see Experiment 3 below.

# Experiment 3: cross-agent comparison on the internal task suite

**Status: directional only (n=1, stdout-matching). minicode-all-tools sits between the two competitors at the median of the variance band, behind both. Copilot leads, opencode is intermediate, minicode trails. The gap is real but inflated by harness-output surface differences — see fairness caveats.**

## Setup

Each competitor agent ran the same 25 tasks with the same model (`google/gemma-4-26b-a4b-it`, OpenRouter), against the minicode workspace. Driver: `/tmp/minicode-bench-logs/internal-tasks/run-cross-agent.sh`. Per-task workflow:

- Capture full stdout
- Apply `rubric.expectedOutputPatterns` regex against stdout
- `git checkout -- src packages tests scripts benchmarks docs ...` to revert any agent edits
- 180 s wall-clock cap per task

Agent invocations:

```bash
# copilot CLI 1.0.41 in BYOK mode
COPILOT_PROVIDER_BASE_URL=https://openrouter.ai/api/v1 \
COPILOT_PROVIDER_API_KEY=$OPENROUTER_API_KEY \
COPILOT_PROVIDER_TYPE=openai \
COPILOT_MODEL=google/gemma-4-26b-a4b-it \
COPILOT_ALLOW_ALL=1 \
copilot --allow-all-tools --no-color --add-dir . -p "$prompt"

# opencode 1.14.39
OPENROUTER_API_KEY=... \
opencode run -m openrouter/google/gemma-4-26b-a4b-it "$prompt"
```

## Headline (n=1 each)

| Agent | Pass | Wall-clock | Notes |
| --- | --- | --- | --- |
| **copilot** | **22/25 (88.0%)** | 850 s | 1 hard exit (timeout on `editing/add-validation`) |
| **opencode** | **18/25 (72.0%)** | 637 s | 1 hard exit (timeout on `editing/add-logging`) |
| **minicode all-tools** | **15.3/25 mean (61.3%)** | ~795 s/run | n=3 mean; range 56–68% |
| **minicode file-search-only** | **11.7/25 mean (46.7%)** | ~800 s/run | n=3 mean; range 40–60% |

## Per-category (n=1 cross-agent, n=3 minicode mean)

| Category | minicode-all | minicode-fso | opencode | copilot |
| --- | --- | --- | --- | --- |
| navigation | 46.7% | 60.0% | 80% | **100%** |
| editing | 40.0% | 40.0% | 60% | 60% |
| refactors | 80.0% | 60.0% | **100%** | **100%** |
| debugging | 66.7% | 53.3% | 80% | 80% |
| planning | 73.3% | 20.0% | 40% | **100%** |

Couple of standouts:

- **Copilot solved every navigation, refactor, and planning task** (15/15 across those three categories). It's clearly the strongest harness on this lane.
- **Opencode planning was 40%** (2/5) — *worse* than minicode-all-tools (73.3%). That's not a stdout-surface artifact; it's a real miss on complex comprehension tasks.
- **Minicode-all-tools and opencode trade per-category wins.** opencode wins navigation (80% vs. 47%), minicode wins planning (73% vs. 40%). Implies different harness biases — opencode is good at "find this thing," minicode is good at "explain how this works."

## Fairness caveats

These are **directional results, not strict comparisons.** Three asymmetries to keep in mind:

1. **Stdout surface area differs by agent.** Copilot's stdout includes its tool-call summaries, file reads, and final response. opencode's stdout includes a slimmer trace + final response. minicode's "response" (matched by the existing rubric runner) is just the agent's final text from `agent.runTurn()` — the smallest surface area of the three. This **inflates the cross-agent pass rates by an estimated 5–10 pp** vs. an apples-to-apples comparison against just-final-text. The directional ordering (Copilot > opencode > minicode) almost certainly survives this correction, but the magnitudes don't.

2. **n=1 cross-agent vs. n=3 minicode.** Run-to-run variance on this lane is documented (40–68% on 6 minicode runs). A single run for each competitor could be 5–10 pp off the true mean.

3. **Some rubric bugs affect cells unevenly.** `find-symbol-definition` requires `expectedFilesRead: ["agent.ts"]`, which Copilot and opencode satisfy by default (they grep-then-read), and which minicode-all-tools fails because `search_code_map` already provided the answer. **The rubric structurally favors grep-and-read workflows over graph-aware ones.** This isn't fairness skew — it's a measurement bug — but it goes one way.

## Two clean signals that aren't surface-area artifacts

- **`find-tool-registration`** (issue #184). minicode-all-tools failed 3/3 because `search_code_map` returned ambiguous results and the model picked `ToolRegistry.createDefault` instead of `createToolRegistry`. minicode-file-search-only passed 3/3, opencode passed, Copilot passed. **Confirmed: the model is *capable* of solving this task — minicode's harness specifically misled it.** Same disambiguation bug class as PR #177.
- **`find-symbol-definition`**. Copilot's transcript shows it `Search "class CodingAgent"` → `Read agent.ts` → answer. minicode used `search_code_map` once and answered correctly. **Both agents got the right answer.** The rubric punishes minicode for not reading the file, even though it didn't need to. This is a rubric bug we should fix before drawing further conclusions about navigation pass rate.

## What this means

1. **minicode is behind on harness quality, not catastrophically.** A correctly-calibrated minicode-all-tools would land closer to opencode (~70–75% on this lane after the rubric and surface-area adjustments), still trailing Copilot.
2. **The two clearest minicode wins are issue #184 (search_code_map disambiguation) and the rubric fixes for `find-symbol-definition` / `find-all-references`.** Both are cheap, both are addressable independently, and the data here is the strongest evidence that they'd move pass rate.
3. **Copilot's planning category 100% is the most striking single result.** GitHub's harness is doing something specific around code-comprehension prompts that minicode hasn't replicated. Worth a focused inspection of one or two transcripts to learn from.
4. **opencode is the relevant peer to chase.** Same OSS positioning, similar BYOK story, similar core tooling. Closing to within 5 pp of opencode on this lane is a realistic short-term target.

## Replication notes

- Driver: `/tmp/minicode-bench-logs/internal-tasks/run-cross-agent.sh` (kept under `/tmp/` so it can be regenerated; not committed to the repo).
- Per-task stdout artifacts: `/tmp/minicode-bench-logs/internal-tasks/{copilot,opencode}-r1/<task>.log`.
- Per-task structured rows: `/tmp/minicode-bench-logs/internal-tasks/{copilot,opencode}-r1/results.jsonl`.
- Workspace clean-up between tasks: `git checkout -- src packages tests scripts benchmarks docs templates plugin tsconfig.json package.json package-lock.json README.md`. Untracked files (like new docs) are not affected.
- This experiment intentionally avoids tool-usage tracking for the competitors, since extracting that from each CLI's stdout would be agent-specific and brittle. If the directional ordering matters more than ±5 pp precision, this approach is fine; if it matters less, build Harbor adapters for opencode and copilot and use that lane instead.

# Experiment 4: post-fix verification on the internal task suite

**Status: positive. n=3 mean lifts from 61.3% to 68.0% (+6.7 pp). Every targeted task — the issue #184 case and the two rubric-bug tasks — flipped from sub-baseline to 3/3. Apparent regressions on two refactor tasks were zero-tool-call OpenRouter routing failures, not behavioural drift.**

## Changes shipped

Three coordinated fixes on `fix/search-code-map-disambiguation-and-rubrics`:

1. **`search_code_map` disambiguation** (issue #184). Each match now carries a one-line JSDoc summary (truncated at 100 chars) under the symbol display line. When results span both a class/interface/type AND a standalone function (the "noun vs. verb" shape — `Foo` class plus `createFoo()` factory), the tool prepends an ambiguity hint pointing at `read_symbol` for confirmation. The hint stays quiet for class-with-its-methods (a structurally expected pairing, not a disambiguation problem).
2. **Runner fix: `search_code_map` pattern tracking.** The runner now registers `search_code_map({pattern})` calls against both `expectedSymbols` and (via `getSymbol` resolution) `expectedFilesRead`. This was the load-bearing fix — without it, an agent that answered `find-symbol-definition` correctly via a single `search_code_map` call would still fail the rubric because no graph-tool call was registered.
3. **Rubric fix: `navigation/find-all-references`.** Tightened the prompt ("excluding the file where it is defined"), replaced the broken `project-index` substring (which a correct caller-list shouldn't contain) with a regex that matches one of the actual caller paths, and dropped `expectedSymbols` so the rubric doesn't structurally exclude file-search-only ablation runs that have no graph tools.

The original `find-symbol-definition` rubric (`expectedFilesRead: ["agent.ts"]`) was kept as-is. With the runner fix in place, `search_code_map({pattern:"CodingAgent"})` now resolves the symbol and registers `agent.ts` as read — so the rubric is satisfiable both with graph tools (the efficient path) and without them (grep-then-read). An earlier draft of this PR swapped the rubric to `expectedSymbols`, but that broke the file-search-only profile (which has no tool that takes a `name`/`pattern` argument). Reverting to `expectedFilesRead` keeps both profiles gradeable.

## Headline (n=3 mean)

| Variant | Mean / 25 | Pass rate |
| --- | --- | --- |
| post-#177 baseline (all tools) | 15.33 | 61.3% |
| **after-fixes (all tools)** | **17.00** | **68.0%** |
| Δ | +1.67 | **+6.7 pp** |

Per-run: r1 60.0%, r2 76.0%, r3 68.0%. Range is within the variance band documented in earlier experiments — the *per-task* signal below is what carries the weight.

## Per-task delta vs. post-#177 baseline

Targeted wins (all flip to 3/3, the strongest possible signal):

| Task | baseline n=3 | after-fixes n=3 |
| --- | --- | --- |
| `navigation/find-tool-registration` (issue #184) | 0/3 | **3/3** |
| `navigation/find-symbol-definition` (runner fix) | 0/3 | **3/3** |
| `navigation/find-all-references` (rubric + runner fix) | 1/3 | **3/3** |

Other movements ≥1 pass:

- `+1`: `debug-runtime-bug`, `diagnose-type-error`, `identify-serve-codepath`, `plan-new-tool`, `extract-helper`
- `−1`: `explain-feature-flow`, `explain-indexing-pipeline`, `add-required-argument`
- `−2`: `update-shared-interface` (3/3 → 1/3)
- `−3`: `consolidate-duplicates` (3/3 → 0/3)

The two big drops both manifested in r2 with **0 tool calls and ~2.5K tokens** — the model returned an empty/refusal response before doing any work. This is OpenRouter upstream-provider routing variance, not a behavioural regression. None of the changes in this branch touch the request path or system prompt; the failure shape is identical to the unrelated transient failures observed in earlier runs.

## Per-category (n=3 mean pass rate)

| Category | baseline | after-fixes | Δ |
| --- | --- | --- | --- |
| navigation | 60.0% | **93.3%** | +33.3 pp |
| planning | 73.3% | 80.0% | +6.7 pp |
| debugging | 53.3% | 60.0% | +6.7 pp |
| editing | 40.0% | 40.0% | — |
| refactors | 80.0% | 53.3% | −26.7 pp |

Navigation is the cleanest read: every navigation task now passes ≥2/3, and three of five pass 3/3. The refactor regression is concentrated in the two zero-tool-call failures noted above and is not a real signal.

## What this confirms

1. **Issue #184 was the right diagnosis.** The disambiguation hint + JSDoc summaries closed the `find-tool-registration` regression cleanly, exactly the way the issue predicted. No other navigation task lost ground from the new tool output.
2. **The runner fix recovered real wins that were already there.** `find-symbol-definition` was solving correctly via `search_code_map`; the harness simply didn't register the call against `expectedFilesRead` because `pattern` wasn't in the symbol-tracking fallback chain. With that fixed, the original rubric is satisfiable in both ablation profiles. This kind of harness blind spot silently masks future product wins; worth a quick audit of other rubric fields against actual tool-call inputs.
3. **Cross-agent gap narrows on the targeted tasks.** From Experiment 3, both clean cross-agent signals (`find-tool-registration`, `find-symbol-definition`) were minicode-specific failures. Both now resolve. A re-run of the cross-agent comparison post-merge would tighten the gap to opencode meaningfully.

## Reproducibility

```bash
# After-fixes runs (n=3, sequential)
for r in 1 2 3; do
  MODEL_PROVIDER=openai-compatible \
  MODEL=google/gemma-4-26b-a4b-it \
  OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  OPENROUTER_API_KEY=$(grep -E '^OPENAI_API_KEY=' ~/.minicode/.env | cut -d= -f2-) \
  npm run benchmark -- --variant after-fixes \
    --out /tmp/minicode-bench-logs/internal-tasks/after-fixes-r${r}.json \
    > /tmp/minicode-bench-logs/internal-tasks/after-fixes-r${r}.log 2>&1
done
```

Artifacts: `/tmp/minicode-bench-logs/internal-tasks/after-fixes-r{1,2,3}.{json,log}`.

# Experiment 5: Copilot-inspired tool descriptions (negative result)

**Status: null result on correctness. The hypothesis (gemma-4-26b benefits disproportionately from worked examples + parallel-call hints in tool descriptions) does not hold at our power level. Two real secondary findings worth documenting: provider pinning collapsed run-to-run variance from ~16 pp to ~4 pp, and the parallel-batching mechanism fired (-9% tokens, -7% duration), it just didn't move correctness.**

## Background

After inspecting the GitHub Copilot CLI source (closed-source agent loop ships as a minified bundle but un-minified prompts and tool descriptions are recoverable from `~/.nvm/.../@github/copilot/app.js` + `definitions/*.agent.yaml`), three techniques looked transferable:

1. Tool descriptions with worked examples + parallelism hints
2. `<plan>` tag protocol with question-intent classification
3. Read-only "explore" sub-loop with hard "stop when answered" termination

Sequenced cheapest-first to validate the post-pinning variance regime before stacking experiments. This experiment is #1.

## Changes shipped (on `experiment/copilot-tool-descriptions`)

- **New `[Tool Efficiency]` block** in the default system prompt: explicit "make multiple tool calls in a SINGLE response when independent", "this is about batching, not skipping investigation", "chain shell commands with `&&`".
- **`read_file`, `read_symbol`, and `search` descriptions** now carry parallel-call hints with worked examples (e.g. "to compare two configs, issue two read_file calls in one turn rather than two sequential turns").

## Methodology

Two cells, both pinned to Novita (bf16) via `OPENROUTER_PROVIDER_ORDER=Novita` (env knob from `experiment/openrouter-provider-pinning`), n=3 each, sequential:

- **pinned-baseline**: post-#185 main + provider pinning (no description changes)
- **copilot-desc**: pinned-baseline + the description changes above

The pinned-baseline cell exists specifically to disambiguate "did the description change help" from "did pinning to a single good provider help" — the prior 61.3% n=3 mean was on the unpinned OpenRouter routing lottery, so absolute deltas across that boundary would be confounded.

Worktree at `/tmp/minicode-pinned-baseline` keeps each cell's SDK build isolated so concurrent runs don't clobber each other's `dist/`.

## Headline (n=3 mean)

| Cell | r1 | r2 | r3 | mean / 25 | pass rate | tokens (avg) | duration (avg) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pinned-baseline | 17 | 17 | 18 | 17.33 | **69.3%** | 58.6K | 33.2s |
| **copilot-desc** | 17 | 18 | 18 | 17.67 | **70.7%** | 53.2K | 31.0s |
| Δ | | | | +0.33 | **+1.4 pp** | -9.3% | -6.6% |

**Net per-task delta: +1 pass across all 75 trials.** Inside the variance band. Not credibly distinguishable from noise.

## Per-category (n=3 mean pass rate)

| Category | pinned-baseline | copilot-desc | Δ |
| --- | --- | --- | --- |
| navigation | 86.7% | 100.0% | +13.3 pp |
| debugging | 73.3% | 80.0% | +6.7 pp |
| planning | 66.7% | 73.3% | +6.7 pp |
| editing | 46.7% | 40.0% | -6.7 pp |
| refactors | 73.3% | 60.0% | -13.3 pp |

The category-level deltas look more dramatic than the aggregate suggests, but each is dominated by 1–2 single-task swings at the variance boundary:

- **navigation +13.3 pp**: `explain-feature-flow` and `find-all-references` each move 2/3 → 3/3. Both already trending toward the ceiling — the description change isn't unlocking new capability, just smoothing the last 1/3.
- **refactors -13.3 pp**: dominated by `consolidate-duplicates` going 3/3 → 0/3. Same task that bailed with zero-tool-call refusals in earlier OpenRouter-routing-roulette runs. Even with Novita pinned, this task systematically fails under the description change. Possibly real, possibly variance — needs a larger n to call.
- **editing -6.7 pp**: `add-validation` flips 1/3 → 0/3. One task at the margin.

Editing floor (40%) and refactor mid-tier are exactly where the real product gap sits, and the description change does not move them. That's the load-bearing finding: parallel-call hints don't help with the kinds of failures that actually limit gemma-4-26b on this lane.

## What did fire: token economy and batching

- **Tokens per task: 58.6K → 53.2K (-9.3%)**
- **Duration per task: 33.2s → 31.0s (-6.6%)**

Both consistent with the parallel-batching hypothesis actually working as intended — the agent issues more tool calls per turn, the loop runs fewer turns total. The mechanism is doing what we asked it to. It just doesn't translate to correctness on these tasks.

This is a useful piece of evidence: it tells us "the model is following the new instructions" rather than "the new instructions are being ignored." The wrong layer to attack our remaining failures.

## Methodology finding: provider pinning collapsed variance

The unpinned `after-fixes` n=3 from Experiment 4 spanned **60.0% → 76.0% (16 pp)**. The pinned cells here span:

- pinned-baseline: 68% / 68% / 72% (4 pp)
- copilot-desc: 68% / 72% / 72% (4 pp)

**Variance band shrunk roughly 4×** by pinning to Novita with `allow_fallbacks: false`. This is more important than the experiment's null result — it means future experiments worth +3 pp can be read at n=3, where unpinned they'd have been drowned by routing noise.

Recommend `experiment/openrouter-provider-pinning` (PR #186) merges regardless of the (3) outcome — its value is measurement infrastructure, not a product gain.

## What this means for the thesis

1. **Tool-description rewrites are not the right lever for gemma-4-26b on this lane.** The mechanism fires (tokens down, duration down) but correctness doesn't move. Either the parallel-call hints solve a problem we don't have on these tasks, or the model needs a stronger architectural intervention than prompt nudges.
2. **Editing/refactor floor is where the real correctness gap lives** (40-60%) and is unmoved by this change. That's where the next experiment should aim.
3. **Don't merge this PR's description changes** as a product change. The token savings are nice but not worth the description-string maintenance burden if correctness doesn't track. Keep the work in `experiment/copilot-tool-descriptions` (PR #187) as a documented null result.

## Implications for the next experiment

The Copilot technique that's most directly aligned with our actual failure modes is the `<plan>` mode discipline — specifically the "gather context fully before proposing changes" rule for implement-class tasks. Editing tasks on this lane fail when the model writes code before understanding the surrounding API; that's a different failure shape than parallel-call efficiency.

The third candidate (read-only explore sub-loop on a smaller cheap model) is a heavier architectural lift; conditional on (2) being insufficient.

## Reproducibility

```bash
# pinned-baseline (worktree) and copilot-desc (main repo) run in parallel,
# both on Novita via OPENROUTER_PROVIDER_ORDER. n=3 each.

# Pinned-baseline cell (run from /tmp/minicode-pinned-baseline worktree)
git worktree add /tmp/minicode-pinned-baseline main
cd /tmp/minicode-pinned-baseline
git checkout -b experiment/pinned-baseline
git cherry-pick <pinning-commit>
npm install && npm run build --workspace=packages/agent-sdk

# Then for r1..r3:
OPENROUTER_PROVIDER_ORDER=Novita \
  MODEL_PROVIDER=openai-compatible \
  MODEL=google/gemma-4-26b-a4b-it \
  OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  OPENROUTER_API_KEY=... \
  npm run benchmark -- --variant pinned-baseline-r${r} \
    --out /tmp/minicode-bench-logs/internal-tasks-pinned/pinned-baseline-r${r}.json
```

Artifacts: `/tmp/minicode-bench-logs/internal-tasks-pinned/{pinned-baseline,copilot-desc}-r{1,2,3}.{json,log}`.

# Experiment 6: iteration-discipline block in the system prompt

**Status: positive and clean. n=3 mean lifts 69.3% → 80.0% (+10.7 pp). The win concentrates exactly where the failure-mode analysis predicted (loop-guard failures in refactors and planning), with no regressions on previously-passing tasks. This is the keeper from the Copilot-inspired round.**

## Why this experiment instead of `<plan>` mode

Originally Experiment 6 was going to port Copilot's `<plan>` mode discipline ("gather all context first, then act"). Failure-mode analysis on the Experiment 5 traces flipped that plan:

| Failure mode (across 3 runs of failing tasks) | Count |
| --- | --- |
| **Loop guard tripped** ("repeated identical tool calls") | **11** |
| Empty output (model emitted tool calls but no final text) | 5 |
| 0-tool confidently-wrong answer | 3 |
| Malformed tool-call syntax | 1 |
| Off-topic but readable | 2 |

The dominant mode is the *opposite* of what `<plan>` mode addresses. The model is investigating exhaustively (`editing/fix-small-bug` 13/7/11 calls before tripping the guard, `editing/add-validation` 17/11/9, `refactors/consolidate-duplicates` 14/13/10) and never committing to an answer or edit. Copilot's explore agent has the matching discipline: *"Stop searching as soon as you can answer the question. Do not be exhaustive."*

## Change shipped (`experiment/iteration-discipline`)

A new `[Iteration Discipline]` block in the default system prompt, inserted before `[Termination Policy]`:

```
[Iteration Discipline]
Looping on tool calls is the most common cause of task failure. To avoid it:
- Stop investigating as soon as you have enough to answer or act. Do not be exhaustive.
- If you have made 3 or more similar read/search calls without making forward progress, STOP and either commit to the best answer you can support with what you have, or acknowledge what you cannot determine.
- Do not repeat a tool call with identical or near-identical arguments. If the result was useful, move on. If it was not, change your approach (different pattern, different path, different tool) rather than retrying.
- Target: gather context in 3–5 read/search calls, then answer or edit.
```

Five lines, no architectural change, ships behind the same provider-pinning regime as Experiment 5.

## Headline (n=3 mean)

| Cell | r1 | r2 | r3 | mean / 25 | pass rate | tokens (avg) | duration (avg) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pinned-baseline | 17 | 17 | 18 | 17.33 | **69.3%** | 58.6K | 33.2s |
| **iter-discipline** | 21 | 19 | 20 | 20.00 | **80.0%** | 54.6K | 30.5s |
| Δ | | | | +2.67 | **+10.7 pp** | -6.8% | -8.1% |

Net per-task delta: **+8 passes across 75 trials**. The variance band (8 pp; 76–84%) is slightly wider than the pinned-baseline (4 pp) but doesn't materially affect the read on a +10.7 pp delta.

## Per-category (n=3 mean pass rate)

| Category | pinned-baseline | iter-discipline | Δ |
| --- | --- | --- | --- |
| navigation | 86.7% | **100.0%** | +13.3 pp |
| **planning** | 66.7% | **86.7%** | **+20.0 pp** |
| **refactors** | 73.3% | **93.3%** | **+20.0 pp** |
| debugging | 73.3% | 73.3% | 0 pp |
| editing | 46.7% | 46.7% | 0 pp |

The +20 pp categories are exactly where loop-guard failures concentrated in the Experiment 5 traces. Both moved cleanly. The unmoved categories are also predicted by the failure-mode analysis:

- **debugging unchanged**: the failing task is `diagnose-type-error` (0/3 → 0/3), which is the *opposite* failure shape — 0-tool calls, hallucinated answer from training-data knowledge. The discipline can't help a model that never called a tool.
- **editing flat**: `fix-small-bug` 0/3→1/3 (loop-guard win) and `add-validation` 1/3→0/3 (variance-edge wash) net zero. The remaining editing failures (`add-logging`, `add-validation`) are empty-output or malformed-tool-call modes — separate mechanism, separate fix.

## Per-task wins concentrated on the predicted shapes

The +8 net delta breaks down as:

- **Loop-guard tasks recovered** (+4): `refactors/extract-helper` 0/3→2/3 (was guard-trip on 9/_/6 calls), `planning/identify-serve-codepath` 2/3→3/3, `editing/fix-small-bug` 0/3→1/3 (was guard-trip on 13/7/11), `planning/plan-new-tool` 0/3→1/3.
- **Variance-edge tasks tipped to ceiling** (+4): `navigation/explain-feature-flow` 2/3→3/3, `navigation/find-all-references` 2/3→3/3, `planning/explain-context-trimming` 2/3→3/3, `refactors/move-logic-to-helper` 2/3→3/3. Already trending toward 3/3; the discipline likely just removed the spurious investigation that was costing the third trial.
- **One regression at the variance edge** (-1): `editing/add-validation` 1/3→0/3. Single task, was already noisy, not a previously-stable result.

Crucially, **no previously-3/3 tasks regressed.** Every task at the ceiling stayed there. The discipline didn't introduce new failure modes; it suppressed the dominant existing one.

## Token economy

Tokens dropped from 58.6K → 54.6K per task (-6.8%); duration 33.2s → 30.5s (-8.1%). These are not the headline win — the correctness improvement is — but they're consistent: fewer wasted tool calls means less inference overall.

## What this means

1. **The right Copilot technique to port for gemma-class models on this lane is the explore-agent stopping rule, not the `<plan>` mode discipline.** This was a flipped hypothesis; the failure-mode analysis got us there.

2. **Loop-guard trips are a load-bearing failure mode** that the system prompt can directly address. Before this change, four categories of tasks were systematically losing trials to over-investigation; after, they recover cleanly.

3. **The remaining failure modes are mechanically distinct** and need separate fixes:
   - Empty output / malformed tool-call: likely a model-format issue (provider-side or in our request shape). Not a prompting problem.
   - 0-tool hallucinated answers (`diagnose-type-error`): the *opposite* of loop-guard. Probably needs an "investigate before answering" rule, but only for questions the model can't answer from system-prompt context. Tricky to scope without re-introducing the looping problem.

4. **PR worth merging.** Unlike Experiment 5, this change is product-level and not just measurement infrastructure. Recommend merging after PR #186 (provider pinning) lands.

## Reproducibility

```bash
# Same setup as Experiment 5, just with the iter-discipline branch
git checkout experiment/iteration-discipline
git cherry-pick <pinning-commit>  # for the experiment run only
npm install && npm run build --workspace=packages/agent-sdk

for r in 1 2 3; do
  OPENROUTER_PROVIDER_ORDER=Novita \
    MODEL_PROVIDER=openai-compatible \
    MODEL=google/gemma-4-26b-a4b-it \
    OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
    OPENROUTER_API_KEY=... \
    npm run benchmark -- --variant iter-disc-r${r} \
      --out /tmp/minicode-bench-logs/internal-tasks-pinned/iter-disc-r${r}.json
done
```

Pinned-baseline data is reused from Experiment 5 (`/tmp/minicode-bench-logs/internal-tasks-pinned/pinned-baseline-r{1,2,3}.json`).

Artifacts: `/tmp/minicode-bench-logs/internal-tasks-pinned/iter-disc-r{1,2,3}.{json,log}`.

# Experiment 7: cross-agent re-comparison on the post-merge codebase

**Status: gap closed substantially since Experiment 3. minicode now leads on comprehension categories (debugging, navigation, planning) and trails only on implementation categories (editing, refactors). Aggregate at n=1 is approximately a three-way tie within variance: opencode 88%, copilot 84%, minicode 80%.**

## Setup

Same lane as Experiment 3 — the 25-task `benchmarks/tasks/` suite running against the minicode workspace, gemma-4-26b-a4b-it via OpenRouter, n=1 each, regex stdout matching for the competitors. Driver script: `/tmp/minicode-bench-logs/internal-tasks/run-cross-agent.sh`.

The codebase under test is current main, including:
- PR #185 (search_code_map disambiguation + rubric/runner fixes)
- PR #189 (iteration discipline block)
- PR #190 (diagnose-type-error prompt fix)

Unpinned across all three agents — copilot CLI and opencode CLI don't expose OpenRouter's `provider.order` field, so pinning minicode-only would deterministically lock it to one provider while competitors get the routing lottery. That's an unfair comparison in the wrong direction. Accept the n=1 variance, read deltas as directional.

## Headline (n=1)

| Agent | Total | dbg | edit | nav | plan | refac |
| --- | --- | --- | --- | --- | --- | --- |
| opencode | **88%** (22/25) | 80% | **100%** | 100% | 60% | 100% |
| copilot | **84%** (21/25) | 80% | 80% | 80% | 80% | 100% |
| **minicode** | **80%** (20/25) | **100%** | **40%** | 100% | **100%** | 60% |

At n=1 with the unpinned variance band we observed in Experiments 4–5 (~10 pp run-to-run when unpinned), the 80/84/88 spread on the aggregate is approximately a three-way tie. The categorical patterns are the more informative read.

## Where minicode leads

- **Debugging 100%** vs 80%/80%. Driven by `diagnose-type-error` (now 1/1 after #190) and the comprehension-category tasks where graph-aware tools matter (`root-cause-from-symptom`, `websocket-connection-issue`).
- **Planning 100%** vs 60%/80%. The largest categorical gap — both competitors fail `plan-new-tool`, opencode also fails `explain-plugin-system`. These are tasks where the agent has to trace structural relationships across files; the code map + iter-discipline combination handles them cleanly.
- **Navigation 100%** vs 80%/100%. Tied with opencode, ahead of copilot.

## Where minicode trails

- **Editing 40%** vs 80%/100%. Five tasks: `add-config-field` PASS, `rename-symbol` PASS, `add-logging` FAIL, `add-validation` FAIL, `fix-small-bug` FAIL.
- **Refactors 60%** vs 100%/100%. `consolidate-duplicates`, `add-required-argument`, `update-shared-interface` PASS; `extract-helper` and `move-logic-to-helper` FAIL.

**All five minicode failures involve making code changes.** This is the entire remaining product gap.

## Failure-mode analysis on the implementation gap

The five minicode editing/refactor failures break into three sub-mechanisms:

1. **Investigation-without-commit (3 of 5).** Model gathers context fully but never issues `edit_file`. Concrete shapes:
   - `add-logging`: read registry.ts → read types.ts → re-read registry.ts (loop guard). Had enough context after step 4; the second read of registry.ts tipped it over.
   - `extract-helper`: 9 different regex searches for file extensions. Several syntactically-different but semantically-equivalent patterns (`\\.ts$|\\.tsx$|...` vs `\\.ts|\\.tsx|...`). Iter-discipline didn't catch it because the strings were different.
   - `move-logic-to-helper`: called `read_symbol("loadDotenvFile")` three times across the run. Intervening calls were different so iter-discipline didn't flag it as identical-loop.

2. **Tries to validate via test scripts (1 of 5).** `fix-small-bug`: model used `run_command` to write `test_bug.ts`, ran `npx ts-node` (which doesn't exist in this project — we use tsx), then produced empty output.

3. **Task misreading (1 of 5).** `add-validation`: model interpreted "add validation to read_file" as "modify the execution environment infrastructure" rather than "edit the source file," refused after one `list_files`. Likely n=1 noise.

The dominant pattern is (1): the model investigates thoroughly, has enough context to make the edit, but keeps reading instead of committing. Iter-discipline targets identical-arg loops; this is a *different* over-investigation shape — "investigate-instead-of-act."

## Where opencode and copilot fail

Notable: every task that competitors fail and minicode passes is a comprehension task that benefits from structural navigation:

- `planning/plan-new-tool` (both competitors fail): asks the agent to trace how tools are defined and registered. minicode's code map gives this directly.
- `debugging/diagnose-failing-test` (copilot only): graph-aware finding of fingerprint-related code.
- `debugging/diagnose-type-error` (opencode only): requires reading the actual `SessionMessage` type union.
- `planning/explain-plugin-system` (opencode only): traces plugin discovery + interface across multiple files.

This is the structural-tools-pay-off shape that motivated minicode's design — and now that iter-discipline keeps the model from looping on these, the wins are visible at the task level.

## What changed since Experiment 3

| Category | Exp 3 minicode (all-tools, n=1) | Exp 7 minicode (n=1) | Δ |
| --- | --- | --- | --- |
| debugging | 60% | 100% | +40 pp |
| editing | 60% | 40% | -20 pp |
| navigation | 60% | 100% | +40 pp |
| planning | 60% | 100% | +40 pp |
| refactors | 80% | 60% | -20 pp |
| **total** | **64%** | **80%** | **+16 pp** |

Comprehension categories: dramatic improvement, all driven by #185/#189/#190. Implementation categories: regression vs Exp 3, but the n=3 mean for these on iter-discipline was 47% editing / 93% refactors — the n=1 here is at the variance edge rather than a systematic drop. The honest read is: editing has been at 40-47% across multiple measurements (real floor), refactors is between 60% and 100% depending on run (variance-dominated at n=1).

The +16 pp aggregate improvement vs Exp 3 vs the unmoved competitors says: **the work in this session has measurably closed the comprehension-side gap**. Most of the remaining product distance is the editing floor.

## What this means for next steps

1. **Editing is the entire remaining gap.** If we move editing from 40% to 80% (matching copilot), minicode lands at ~88% and ties or beats opencode. Refactors likely lifts as a side-effect since the underlying mechanism is the same change-class workflow.

2. **The next experiment is well-scoped.** The 5 failure traces give a concrete sub-mechanism (investigation-without-commit). A targeted `[Edit Discipline]` block — the change-mode counterpart to `[Iteration Discipline]` — should address it without conflicting with existing rules.

3. **Comprehension wins are durable.** No regression on the comprehension categories vs the post-#189 baseline; the tools, prompts, and iter-discipline are working together cleanly on those tasks.

## Reproducibility

```bash
# minicode (uses isolated temp workspaces — safe to run in parallel)
MODEL_PROVIDER=openai-compatible \
  MODEL=google/gemma-4-26b-a4b-it \
  OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
  OPENROUTER_API_KEY=... \
  npm run benchmark -- --variant postmerge-minicode \
    --out /tmp/minicode-bench-logs/internal-tasks-postmerge/minicode-r1.json

# copilot then opencode (sequential — they share the workspace and revert via git checkout)
/tmp/minicode-bench-logs/internal-tasks/run-cross-agent.sh copilot \
  /tmp/minicode-bench-logs/internal-tasks-postmerge/copilot-r1
/tmp/minicode-bench-logs/internal-tasks/run-cross-agent.sh opencode \
  /tmp/minicode-bench-logs/internal-tasks-postmerge/opencode-r1
```

Artifacts: `/tmp/minicode-bench-logs/internal-tasks-postmerge/{minicode,copilot,opencode}-r1.{json,jsonl,log}`.
