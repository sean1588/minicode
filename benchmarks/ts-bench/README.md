# `ts-bench` Integration

This directory documents how to run `minicode` against [`ts-bench`](https://github.com/laiso/ts-bench) without changing the product runtime.

The integration has two moving parts:

- [`scripts/ts-bench-adapter.ts`](../../scripts/ts-bench-adapter.ts) patches a local `ts-bench` checkout to register `minicode` as an agent.
- [`scripts/run-ts-bench-smoke.ts`](../../scripts/run-ts-bench-smoke.ts) points that checkout at the current local `minicode` branch through a repo-local shim and runs a smoke exercise.

## Clone `ts-bench`

```bash
git clone https://github.com/laiso/ts-bench.git /tmp/ts-bench
```

## Patch the checkout

```bash
source ~/.nvm/nvm.sh
nvm use 22 >/dev/null
node --import tsx scripts/ts-bench-adapter.ts --ts-bench-path /tmp/ts-bench
```

This patches the local `ts-bench` checkout in place:

- `src/agents/registry.ts`
- `scripts/agents.json`
- `src/site/shared/format.ts`
- `src/utils/version-detector.ts`
- `src/utils/leaderboard-generator.ts`

## Smoke run

```bash
source ~/.nvm/nvm.sh
nvm use 22 >/dev/null
node --import tsx scripts/run-ts-bench-smoke.ts \
  --ts-bench-path /tmp/ts-bench \
  --exercise acronym \
  --provider openrouter \
  --model google/gemini-3-flash-preview \
  --env-file ~/.minicode/.env \
  --install-deps
```

What this does:

- builds the current `minicode` branch unless `--skip-build` is passed
- patches the target `ts-bench` checkout
- creates `/tmp/ts-bench/.minicode-local-bin/minicode` as a shim to the current local `dist/src/index.js`
- sets `MINICODE_BENCHMARK_CONFIG` to [`benchmarks/benchmark.config.json`](../benchmark.config.json)
- optionally forwards a dotenv file through `MINICODE_BENCHMARK_ENV_FILE`
- runs:

```bash
bun src/index.ts \
  --agent minicode \
  --version local-dev \
  --dataset v1 \
  --exercise acronym \
  --provider openrouter \
  --model google/gemini-3-flash-preview \
  --output-format json
```

## Supported providers

The `minicode` adapter currently supports:

- `openrouter`
- `openai`
- `anthropic`

Provider mapping inside `ts-bench`:

- `openrouter` -> `minicode benchmark run --provider openai-compatible --base-url https://openrouter.ai/api/v1`
- `openai` -> `minicode benchmark run --provider openai-compatible --base-url https://api.openai.com/v1`
- `anthropic` -> `minicode benchmark run --provider anthropic`

## Benchmark env knobs

The adapter passes through these optional env vars when you want to tune the run from the benchmark layer:

- `MINICODE_BENCHMARK_CONFIG`
- `MINICODE_BENCHMARK_ENV_FILE`
- `MINICODE_OPENROUTER_BASE_URL`
- `MINICODE_OPENAI_BASE_URL`
- `MINICODE_BENCHMARK_MAX_STEPS`
- `MINICODE_BENCHMARK_MAX_CONTEXT_TOKENS`
- `MINICODE_BENCHMARK_COMMAND_TIMEOUT_MS`
- `MINICODE_BENCHMARK_MODEL_TIMEOUT_SECONDS`
- `MINICODE_BENCHMARK_MAX_TOOL_OUTPUT_CHARS`

## Comparison lanes

### `common-model`

Use the same provider/model pairing across every agent that can support it. For the first pass we should prefer a broadly available OpenRouter model so the harness is testing the agent shell more than model differences.

Example target:

- provider: `openrouter`
- model: `google/gemini-3-flash-preview`

### `native-best`

Run each agent with the provider/model combo that best matches how users are most likely to evaluate it in the wild.

Examples:

- `minicode`: OpenRouter + `google/gemini-3-flash-preview`
- `Claude Code`: Anthropic + a current Claude model
- `Codex CLI`: OpenAI + a current Codex model
- `OpenCode`: its strongest supported default pairing

Keep these results separate from `common-model` so we do not blur harness quality with provider/model differences.
