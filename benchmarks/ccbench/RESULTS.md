# CCBench JS/TS Results

This file records minicode runs against the public JavaScript and TypeScript
subset of [`codecrafters-io/ccbench`](https://github.com/codecrafters-io/ccbench).

## Local Runs

| Date | Agent | Provider | Model | Scope | Score | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-04-30 | minicode | OpenRouter | `moonshotai/kimi-k2.6` | 9 public JS/TS tasks | `11.1%` (`1/9`) | Full JS/TS subset through Harbor using the current PR tarball and softened tool guidance. Runtime: `51m27s`. Exceptions: `0`. Job: `/tmp/minicode-ccbench-jobs/kimi-k2-6-js-ts/result.json`. |
| 2026-04-30 | minicode | OpenRouter | `qwen/qwen3-14b` | 2-task prompt ablation, `maxContextTokens=30000` | `0%` (`0/2`) | Local-sized model probe against the two flip-prone TypeScript tasks. Both current and softened prompts failed; softened prompt hit repeated-tool-call stops on both tasks. Jobs: `/tmp/minicode-ccbench-ablation-jobs/qwen3-14b-current-prompt-two-task/result.json`, `/tmp/minicode-ccbench-ablation-jobs/qwen3-14b-soft-prompt-two-task/result.json`. |
| 2026-04-29 | minicode | OpenRouter | `openai/gpt-5.4` | 9 public JS/TS tasks, `maxSteps=150` | `22.2%` (`2/9`) | Follow-up turn-budget lane. Runtime: `33m14s`. Exceptions: `0`. No task came close to the 150-step ceiling; two previously passing tasks regressed. Job: `/tmp/minicode-ccbench-jobs/2026-04-29__23-01-24/result.json`. |
| 2026-04-29 | minicode | OpenRouter | `openai/gpt-5.4` | 9 public JS/TS tasks | `44.4%` (`4/9`) | Full JS/TS subset through Harbor. Runtime: `40m21s`. Exceptions: `0`. Job: `/tmp/minicode-ccbench-jobs/2026-04-29__22-07-41/result.json`. |
| 2026-04-29 | minicode | OpenRouter | `anthropic/claude-sonnet-4.6` | 1 TypeScript smoke task | `0/1` | Harbor plumbing reached the task, but the model request failed with OpenRouter `402 Insufficient credits`; this is not a valid capability result. |

## Current Status

The Harbor adapter and CCBench JS/TS wrapper are ready. The first valid JS/TS
subset run completed with `minicode + openai/gpt-5.4` through OpenRouter:

- score: `44.4%` (`4/9`)
- runtime: `40m21s`
- exceptions: `0`
- tokens: `3,567,729` input and `75,391` output, as reported by Harbor

A follow-up run with `maxSteps=150` scored lower at `22.2%` (`2/9`). No task
approached 150 assistant steps, so the initial `50`-step cap does not appear to
explain the `44.4%` baseline. The higher-budget run is useful evidence that
turn budget alone is not the next optimization target.

A focused two-task rerun on the tasks that regressed in the `maxSteps=150` lane
showed both tasks can pass repeatedly, which reinforces that run-to-run variance
is high on this small sample. A softened tool-guidance prompt also passed both
tasks while using fewer total calls and far fewer input tokens. This is only a
small ablation slice, but it suggests the next full-lane experiment should test
the softer prompt before drawing conclusions about symbol-aware tools.

To reproduce:

```bash
CCBENCH_PACKAGE_SPEC=@sean.holung/minicode ./scripts/run-ccbench-js-ts.sh
```

For local unpublished changes, serve a tarball and set `CCBENCH_PACKAGE_SPEC` to
the tarball URL as documented in [`README.md`](./README.md).

## Fairness Notes

- The official CCBench leaderboard reports full-suite results across roughly
  180 tasks. This file tracks the JS/TS subset first because those languages
  match minicode's strongest parser support today.
- CCBench's official results use each agent's native harness and model pairing.
  Minicode results should list provider, model, context limit, timeout, and
  package version so future comparisons are honest.
- A JS/TS-only score should not be presented as directly equivalent to the
  official full-suite CCBench percentage.

## 2026-04-29 GPT-5.4 JS/TS Breakdown

| Task | Reward | Duration | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Specialized tools |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `grep-backreferences-typescript-gnu-309` | `1.0` | `113.3s` | `20` | `1` | `6` | `0` | `8` | `2` | `read_symbol` `1` |
| `interpreter-control-flow-typescript-wolf-690` | `1.0` | `104.2s` | `67` | `26` | `25` | `1` | `3` | `10` | `read_symbol` `23`, `search_code_map` `3` |
| `interpreter-resolving-binding-typescript-walrus-974` | `0.0` | `142.7s` | `79` | `20` | `28` | `2` | `3` | `23` | `read_symbol` `12`, `search_code_map` `8` |
| `interpreter-statements-and-state-typescript-armadillo-657` | `1.0` | `244.4s` | `65` | `5` | `17` | `1` | `30` | `10` | `read_symbol` `5` |
| `kafka-consuming-messages-javascript-platypus-901` | `0.0` | `55.4s` | `43` | `9` | `17` | `7` | `1` | `5` | `read_symbol` `5`, `search_code_map` `4` |
| `kafka-listing-partitions-javascript-fox-266` | `0.0` | `97.7s` | `20` | `0` | `8` | `2` | `4` | `2` | none |
| `kafka-listing-partitions-javascript-beetle-650` | `0.0` | `95.8s` | `28` | `3` | `14` | `1` | `5` | `2` | `read_symbol` `3` |
| `redis-transactions-javascript-antelope-677` | `0.0` | `100.0s` | `44` | `2` | `27` | `4` | `1` | `6` | `search_code_map` `2` |
| `redis-transactions-typescript-mallard-191` | `1.0` | `86.3s` | `22` | `0` | `14` | `0` | `3` | `4` | none |

Aggregate tool usage:

- total tool calls: `388`
- specialized structural tool calls: `66` (`17.0%`)
- file reads: `156` (`40.2%`)
- searches: `18`
- shell commands: `58`
- mutations: `64`

## 2026-04-29 GPT-5.4 JS/TS Breakdown, `maxSteps=150`

| Task | Reward | Assistant steps | Duration | Tool calls | Specialized | File reads | Searches | Commands | Mutations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `grep-backreferences-typescript-gnu-309` | `1.0` | `8` | `76.0s` | `16` | `1` | `5` | `0` | `7` | `2` |
| `interpreter-control-flow-typescript-wolf-690` | `1.0` | `17` | `108.5s` | `72` | `16` | `32` | `6` | `4` | `8` |
| `interpreter-resolving-binding-typescript-walrus-974` | `0.0` | `48` | `166.4s` | `94` | `39` | `19` | `2` | `3` | `27` |
| `interpreter-statements-and-state-typescript-armadillo-657` | `0.0` | `9` | `76.0s` | `26` | `4` | `14` | `0` | `2` | `3` |
| `kafka-consuming-messages-javascript-platypus-901` | `0.0` | `12` | `62.0s` | `35` | `10` | `14` | `3` | `1` | `4` |
| `kafka-listing-partitions-javascript-beetle-650` | `0.0` | `9` | `61.9s` | `19` | `3` | `7` | `1` | `4` | `1` |
| `kafka-listing-partitions-javascript-fox-266` | `0.0` | `9` | `77.8s` | `22` | `0` | `9` | `2` | `6` | `1` |
| `redis-transactions-javascript-antelope-677` | `0.0` | `13` | `62.0s` | `39` | `0` | `22` | `5` | `1` | `7` |
| `redis-transactions-typescript-mallard-191` | `0.0` | `11` | `88.4s` | `24` | `1` | `14` | `0` | `3` | `5` |

Aggregate tool usage:

- total tool calls: `347`
- specialized structural tool calls: `74` (`21.3%`)
- file reads: `136` (`39.2%`)
- searches: `19`
- shell commands: `31`
- mutations: `58`

## 2026-04-30 Kimi K2.6 JS/TS Breakdown

This run used `moonshotai/kimi-k2.6` through OpenRouter with
`maxContextTokens=100000`, the current PR tarball, and the softened tool
guidance prompt. OpenRouter also exposes a moving `~moonshotai/kimi-latest`
alias, but this run used the explicit model ID so the result remains
reproducible.

| Task | Reward | Duration | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Specialized tools |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `grep-backreferences-typescript-gnu-309` | `0.0` | `94s` | `7` | `0` | `4` | `0` | `0` | `0` | none |
| `interpreter-control-flow-typescript-wolf-690` | `1.0` | `405s` | `71` | `15` | `23` | `0` | `20` | `11` | `read_symbol` `12`, `search_code_map` `3` |
| `interpreter-resolving-binding-typescript-walrus-974` | `0.0` | `349s` | `40` | `11` | `22` | `1` | `3` | `0` | `read_symbol` `11` |
| `interpreter-statements-and-state-typescript-armadillo-657` | `0.0` | `102s` | `16` | `0` | `14` | `0` | `0` | `0` | none |
| `kafka-consuming-messages-javascript-platypus-901` | `0.0` | `103s` | `15` | `0` | `12` | `0` | `0` | `0` | none |
| `kafka-listing-partitions-javascript-beetle-650` | `0.0` | `326s` | `17` | `0` | `13` | `0` | `1` | `0` | none |
| `kafka-listing-partitions-javascript-fox-266` | `0.0` | `231s` | `16` | `0` | `13` | `0` | `0` | `0` | none |
| `redis-transactions-javascript-antelope-677` | `0.0` | `127s` | `21` | `0` | `18` | `0` | `0` | `0` | none |
| `redis-transactions-typescript-mallard-191` | `0.0` | `214s` | `16` | `0` | `14` | `0` | `0` | `0` | none |

Aggregate tool usage:

- total tool calls: `219`
- specialized structural tool calls: `26` (`11.9%`)
- file reads: `133` (`60.7%`)
- searches: `1`
- shell commands: `24`
- mutations: `11`

Notes:

- Kimi K2.6 completed the full JS/TS lane without infra exceptions but scored
  `11.1%` (`1/9`), below the GPT-5.4 baseline.
- The successful task was the only one where the model entered a full
  implementation loop with mutations and repeated command execution.
- Most failed tasks ended after inspection with zero mutations, so the dominant
  failure mode appears to be under-action rather than tool failure.
- The result suggests Kimi may need stronger benchmark-mode instruction to
  implement and test changes, but the same prompt should not be changed
  mid-comparison without rerunning the other baselines.

## 2026-04-30 Two-Task Prompt Ablation

Scope:

- `interpreter-statements-and-state-typescript-armadillo-657`
- `redis-transactions-typescript-mallard-191`

Both tasks had passed in the default full-lane run and failed in the
`maxSteps=150` full-lane run. The reruns below use `openai/gpt-5.4` through
OpenRouter.

| Prompt | Score | Runtime | Input tokens | Output tokens | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Job |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current prompt | `100%` (`2/2`) | `9m55s` | `1,454,623` | `17,059` | `89` | `5` | `23` | `3` | `24` | `29` | `/tmp/minicode-ccbench-ablation-jobs/current-prompt-two-task/result.json` |
| Softened tool guidance | `100%` (`2/2`) | `9m17s` | `570,749` | `17,727` | `60` | `0` | `34` | `3` | `6` | `13` | `/tmp/minicode-ccbench-ablation-jobs/soft-prompt-two-task/result.json` |

Per-task detail:

| Prompt | Task | Reward | Assistant steps | Tool calls | Specialized | File reads | Commands | Mutations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current | `interpreter-statements-and-state-typescript-armadillo-657` | `1.0` | `39` | `57` | `2` | `19` | `23` | `10` |
| Current | `redis-transactions-typescript-mallard-191` | `1.0` | `25` | `32` | `3` | `4` | `1` | `19` |
| Softened | `interpreter-statements-and-state-typescript-armadillo-657` | `1.0` | `13` | `32` | `0` | `18` | `3` | `7` |
| Softened | `redis-transactions-typescript-mallard-191` | `1.0` | `15` | `28` | `0` | `16` | `3` | `6` |

## 2026-04-30 Qwen3-14B Two-Task Prompt Ablation

This run repeats the two-task prompt ablation with `qwen/qwen3-14b` through
OpenRouter and `maxContextTokens=30000` to approximate a more local-sized model
profile. It is a capability probe, not a leaderboard result.

| Prompt | Score | Runtime | Input tokens | Output tokens | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Repeated stops | Job |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current prompt | `0%` (`0/2`) | `10m31s` | `73,323` | `16,378` | `19` | `14` | `3` | `0` | `0` | `2` | `0` | `/tmp/minicode-ccbench-ablation-jobs/qwen3-14b-current-prompt-two-task/result.json` |
| Softened tool guidance | `0%` (`0/2`) | `16m56s` | `141,428` | `41,391` | `25` | `20` | `4` | `1` | `0` | `0` | `2` | `/tmp/minicode-ccbench-ablation-jobs/qwen3-14b-soft-prompt-two-task/result.json` |

Per-task detail:

| Prompt | Task | Reward | Duration | Tool calls | Specialized | File reads | Searches | Commands | Mutations | Repeated stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current | `interpreter-statements-and-state-typescript-armadillo-657` | `0.0` | `200s` | `10` | `6` | `2` | `0` | `0` | `2` | `false` |
| Current | `redis-transactions-typescript-mallard-191` | `0.0` | `111s` | `9` | `8` | `1` | `0` | `0` | `0` | `false` |
| Softened | `interpreter-statements-and-state-typescript-armadillo-657` | `0.0` | `153s` | `8` | `8` | `0` | `0` | `0` | `0` | `true` |
| Softened | `redis-transactions-typescript-mallard-191` | `0.0` | `535s` | `17` | `12` | `4` | `1` | `0` | `0` | `true` |

Notes:

- `qwen/qwen3-14b` failed both tasks under both prompt variants, so this run
  does not support choosing a prompt from pass rate alone.
- The current prompt produced a small number of edits but under-read broader
  file context and never ran commands.
- The softened prompt consumed more tokens and triggered the repeated-tool-call
  guard on both tasks, including repeated `read_symbol` calls on the
  interpreter task and repeated `read_file` calls on the Redis task.
- For this model class, the next useful experiment is likely not more turn
  budget. Better candidates are stronger loop recovery, explicit test-running
  nudges, or a model profile that is less eager to keep inspecting after it has
  enough context.

## Published Full-Suite Baselines

Observed from the official CCBench README on 2026-04-29:

| Agent | Model | Success rate |
| --- | --- | --- |
| Codex CLI | `gpt-5.2-codex` | `75.4%` |
| Claude Code | `claude-opus-4.6` | `72.7%` |
| Claude Code | `claude-opus-4.5` | `58.3%` |
| Gemini CLI | `gemini-3-flash-preview` | `51.3%` |
| Gemini CLI | `gemini-3-pro-preview` | `47.6%` |
| Codex CLI | `gpt-5.1-codex-mini` | `42.2%` |
| Claude Code | `claude-sonnet-4.5` | `34.2%` |
| Claude Code | `claude-haiku-4.5` | `21.9%` |
