# CCBench JS/TS Results

This file records minicode runs against the public JavaScript and TypeScript
subset of [`codecrafters-io/ccbench`](https://github.com/codecrafters-io/ccbench).

## Local Runs

| Date | Agent | Provider | Model | Scope | Score | Notes |
| --- | --- | --- | --- | --- | --- | --- |
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
