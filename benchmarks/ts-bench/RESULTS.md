# `ts-bench` Results

This file records the current benchmark numbers we have gathered for `minicode` on the `ts-bench` v1 top-25 TypeScript lane, plus a few published comparison points from the official `ts-bench` leaderboard.

## Local `minicode` runs

| Date | Agent | Provider | Model | Context | Start timeout | Score | Solved | Avg time | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-04-29 | minicode | OpenRouter | `anthropic/claude-sonnet-4.6` | `100k` | `120s` | `100%` | `25/25` | `31.6s` | Post-hardening full top-25 run |
| 2026-04-29 | minicode | OpenRouter | `google/gemini-3-flash-preview` | `32k` | `60s` | `88%` | `22/25` | `39.3s` | Failed: `accumulate`, `all-your-base`, `diamond` |
| 2026-04-29 | minicode | OpenRouter | `openai/gpt-5` | `100k` | `60s` | `92%` | `23/25` | `93.7s` | Failed: `alphametics` (`300s` task timeout), `bowling` (`60s` model-start timeout) |

The Gemini and GPT-5 runs were captured before the benchmark hardening landed. The Claude Sonnet 4.6 run uses the current default benchmark profile:

- `maxContextTokens = 100000`
- `modelTimeoutSeconds = 120`
- benchmark-specific non-interactive prompt guidance with a one-time approval-seeking retry

That makes the Claude Sonnet 4.6 lane the current clean baseline for the hardened benchmark setup.

## Smoke validation after hardening

After the benchmark prompt/timeout hardening in this branch, `minicode + gpt-5.3-codex` completed the `acronym` smoke run successfully in `41.7s` through the bash wrapper. Before this change, the same model family was frequently responding with approval-seeking text and empty patches instead of acting.

## Published `ts-bench` leaderboard points

Observed from the official `ts-bench` README leaderboard snapshot on 2026-04-28:

| Agent | Model | Score | Solved | Avg time |
| --- | --- | --- | --- | --- |
| OpenCode | `openai/gpt-5` | `96%` | `24/25` | `64.8s` |
| Claude Code | `glm-4.6` | `92%` | `23/25` | `132.3s` |
| Codex CLI | `gpt-5` | `88%` | `22/25` | `91.7s` |
| Codex CLI | `gpt-5.1-codex` | `88%` | `22/25` | `145.2s` |
| OpenCode | `anthropic/claude-sonnet-4-20250514` | `92%` | `23/25` | `127.8s` |

## Reading the numbers

- The strongest local baseline we currently have is `minicode + anthropic/claude-sonnet-4.6` at `100%`.
- The `gemini-3-flash-preview` lane is much faster and cheaper, but clearly not as capable on this benchmark.
- The Codex-model lane surfaced a prompt-mode mismatch rather than a pure capability limit, which is why this branch adds benchmark-specific non-interactive execution guidance.

## Sources

- Official `ts-bench` repository: <https://github.com/laiso/ts-bench>
- Official README snapshot used for the published comparison table: <https://github.com/laiso/ts-bench>
