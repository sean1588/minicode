# CCBench JS/TS

This directory documents running `minicode` against the public JavaScript and
TypeScript subset of [`codecrafters-io/ccbench`](https://github.com/codecrafters-io/ccbench).

CCBench tasks use the Harbor task format, so minicode runs through the generic
Harbor adapter in [`benchmarks/harbor`](../harbor/README.md). The integration
does not import or special-case product internals.

## Scope

The current public CCBench repository has 187 tasks. The JS/TS subset contains
9 tasks:

- `grep-backreferences-typescript-gnu-309`
- `interpreter-control-flow-typescript-wolf-690`
- `interpreter-resolving-binding-typescript-walrus-974`
- `interpreter-statements-and-state-typescript-armadillo-657`
- `kafka-consuming-messages-javascript-platypus-901`
- `kafka-listing-partitions-javascript-beetle-650`
- `kafka-listing-partitions-javascript-fox-266`
- `redis-transactions-javascript-antelope-677`
- `redis-transactions-typescript-mallard-191`

## Run

Use the wrapper from the repository root:

```bash
./scripts/run-ccbench-js-ts.sh
```

The wrapper clones or updates CCBench under `/tmp/ccbench`, filters Harbor to
`*javascript*` and `*typescript*` task names, and stores jobs under
`/tmp/minicode-ccbench-jobs`.

Default settings:

- provider: `openrouter`
- model: `anthropic/claude-sonnet-4.6`
- context: `100000` tokens
- model start timeout: `180` seconds
- concurrency: `1`
- env file: `~/.minicode/.env`

Override with environment variables:

```bash
CCBENCH_MODEL=openai/gpt-5.4 \
CCBENCH_PROVIDER=openrouter \
CCBENCH_PACKAGE_SPEC=@sean.holung/minicode \
./scripts/run-ccbench-js-ts.sh
```

For local adapter/package development before publishing a release, build and
serve a tarball:

```bash
source ~/.nvm/nvm.sh
nvm use 22 >/dev/null
npm run build
npm pack --pack-destination /tmp
cd /tmp && python3 -m http.server 18081 --bind 0.0.0.0
```

Then run:

```bash
CCBENCH_PACKAGE_SPEC=http://host.docker.internal:18081/sean.holung-minicode-0.2.0.tgz \
./scripts/run-ccbench-js-ts.sh
```

## Published Comparison Points

The official CCBench leaderboard reported these full-benchmark results on
2026-02-11:

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

These are full CCBench results across roughly 180 tasks, not JS/TS-only results,
so compare them directionally unless we also run the full suite.

## Result Log

Recorded minicode results live in [`RESULTS.md`](./RESULTS.md).
