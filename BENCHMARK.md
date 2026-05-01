# Benchmarking

`minicode` has three benchmark surfaces:

- `minicode benchmark run` for non-interactive harness integrations
- `ts-bench` for external TypeScript agent comparisons
- `CCBench` through Harbor for realistic CodeCrafters JS/TS tasks
- `SWE-bench Verified` through Harbor for real Python bug-fixing tasks

## Quick Start

Run the `ts-bench` top-25 lane with the repository defaults:

```bash
TS_BENCH_MODEL=openai/gpt-5 npm run benchmark:ts-bench
```

Or invoke the wrapper directly:

```bash
TS_BENCH_MODEL=openai/gpt-5 ./scripts/run-ts-bench.sh
```

By default the wrapper will:

- clone `ts-bench` into `/tmp/ts-bench` if it is missing
- use Node `22` through `nvm` when available
- build the current local `minicode` branch
- patch the local `ts-bench` checkout to register `minicode`
- run the v1 top-25 TypeScript lane

Results are written by `ts-bench` under `/tmp/ts-bench/results/`.

Run the public CCBench JavaScript/TypeScript subset through Harbor:

```bash
npm run benchmark:ccbench:js-ts
```

By default the wrapper clones CCBench into `/tmp/ccbench`, filters to task names
containing `javascript` or `typescript`, and writes Harbor jobs under
`/tmp/minicode-ccbench-jobs`.

Run a SWE-bench Verified smoke task through Harbor:

```bash
npm run benchmark:swebench
```

By default the wrapper runs one registered `swebench-verified` task with
`openai/gpt-5.4` and writes Harbor jobs under `/tmp/minicode-swebench-jobs`.
Use `SWEBENCH_N_TASKS` and `SWEBENCH_INCLUDE_TASK_NAME` to run a curated subset
before attempting the full 500-task lane.

Run the full registered SWE-bench Verified set by clearing the default task
limit:

```bash
SWEBENCH_N_TASKS= npm run benchmark:swebench
```

## Important env vars

- `TS_BENCH_MODEL`: model id to evaluate, for example `openai/gpt-5`
- `TS_BENCH_PROVIDER`: `openrouter`, `openai`, or `anthropic`
- `TS_BENCH_EXERCISE`: `25` for the full v1 lane, or a single exercise like `acronym`
- `TS_BENCH_ENV_FILE`: dotenv file with provider credentials. Defaults to `~/.minicode/.env`
- `TS_BENCH_INSTALL_DEPS`: set to `0` to skip `bun install`
- `TS_BENCH_SKIP_BUILD`: set to `1` to skip rebuilding `minicode`
- `CCBENCH_MODEL`: model id for CCBench, defaults to `anthropic/claude-sonnet-4.6`
- `CCBENCH_PROVIDER`: `openrouter`, `openai`, `openai-compatible`, or `anthropic`
- `CCBENCH_PACKAGE_SPEC`: npm package spec installed inside Harbor containers
- `CCBENCH_ENV_FILE`: dotenv file with provider credentials. Defaults to `~/.minicode/.env`
- `SWEBENCH_MODEL`: model id for SWE-bench, defaults to `openai/gpt-5.4`
- `SWEBENCH_PROVIDER`: `openrouter`, `openai`, `openai-compatible`, or `anthropic`
- `SWEBENCH_PACKAGE_SPEC`: npm package spec installed inside Harbor containers
- `SWEBENCH_N_TASKS`: task limit for smoke/subset runs. Defaults to `1`; set empty to run the full registered dataset
- `SWEBENCH_INCLUDE_TASK_NAME`: optional Harbor task-name glob filter
- `SWEBENCH_ENV_FILE`: dotenv file with provider credentials. Defaults to `~/.minicode/.env`

Advanced benchmark-layer tuning still works through the `MINICODE_BENCHMARK_*` env vars described in [benchmarks/ts-bench/README.md](./benchmarks/ts-bench/README.md).

## Benchmark profile

The default benchmark config lives in [benchmarks/benchmark.config.json](./benchmarks/benchmark.config.json). It intentionally differs from the normal interactive defaults:

- `maxContextTokens`: `100000`
- `modelTimeoutSeconds`: `120`
- dynamic system prompts remain disabled by default

Benchmark mode also adds a non-interactive system-prompt suffix so the agent acts immediately instead of asking for approval, and it retries once if a model still responds with a confirmation-seeking completion.

## More detail

- Runtime/reference docs: [docs/BENCHMARKING.md](./docs/BENCHMARKING.md)
- `ts-bench` workflow details: [benchmarks/ts-bench/README.md](./benchmarks/ts-bench/README.md)
- CCBench workflow details: [benchmarks/ccbench/README.md](./benchmarks/ccbench/README.md)
- SWE-bench workflow details: [benchmarks/swebench/README.md](./benchmarks/swebench/README.md)
- Current `ts-bench` results: [benchmarks/ts-bench/RESULTS.md](./benchmarks/ts-bench/RESULTS.md)
- Current CCBench results: [benchmarks/ccbench/RESULTS.md](./benchmarks/ccbench/RESULTS.md)
- Current SWE-bench results: [benchmarks/swebench/RESULTS.md](./benchmarks/swebench/RESULTS.md)
