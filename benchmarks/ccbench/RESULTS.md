# CCBench JS/TS Results

This file records minicode runs against the public JavaScript and TypeScript
subset of [`codecrafters-io/ccbench`](https://github.com/codecrafters-io/ccbench).

## Local Runs

| Date | Agent | Provider | Model | Scope | Score | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-04-29 | minicode | OpenRouter | `anthropic/claude-sonnet-4.6` | 1 TypeScript smoke task | `0/1` | Harbor plumbing reached the task, but the model request failed with OpenRouter `402 Insufficient credits`; this is not a valid capability result. |

## Current Status

The Harbor adapter and CCBench JS/TS wrapper are ready, and the smoke run now
fails honestly when the model provider rejects the request. A valid scored run
still needs model credits or a direct provider key. Use:

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
