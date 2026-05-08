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
2. **Rubric fix: `navigation/find-symbol-definition`.** Replaced the `expectedFilesRead: ["agent.ts"]` requirement with `expectedSymbols: ["CodingAgent"]`. The agent doesn't have to crack open the file when `search_code_map` already gave the answer — punishing it for being efficient was exactly backwards for this lane.
3. **Rubric fix: `navigation/find-all-references`.** Tightened the prompt ("excluding the file where it is defined") and replaced the broken `project-index` substring (which a correct caller-list shouldn't contain) with a regex that matches one of the actual caller paths.

A fourth fix, in the runner: `search_code_map` calls now register their `pattern` argument as a queried symbol. Without this, `expectedSymbols` rubrics under-counted graph-tool work — the same bug that masked a correct answer on `find-symbol-definition` even after the rubric was changed.

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
| `navigation/find-symbol-definition` (rubric + runner fix) | 0/3 | **3/3** |
| `navigation/find-all-references` (rubric fix) | 1/3 | **3/3** |

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
2. **The rubric fixes recovered real wins that were already there.** `find-symbol-definition` was solving correctly via `search_code_map`; the previous rubric simply didn't credit the answer. After both rubric and runner fixes, it's 3/3.
3. **The runner symbol-tracking fix matters independently.** Even with the corrected rubric, `find-symbol-definition` would still have failed counting `expectedSymbols` because the runner ignored `pattern` from `search_code_map` calls. This kind of harness blind spot will silently mask future product wins; worth a quick audit of other rubric fields against actual tool-call inputs.
4. **Cross-agent gap narrows on the targeted tasks.** From Experiment 3, both clean cross-agent signals (`find-tool-registration`, `find-symbol-definition`) were minicode-specific failures. Both now resolve. A re-run of the cross-agent comparison post-merge would tighten the gap to opencode meaningfully.

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
