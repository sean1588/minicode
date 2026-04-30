# Harbor Adapter

This directory contains a custom Harbor installed-agent adapter for minicode.
It lets Harbor invoke minicode through the stable benchmark entrypoint:

```bash
minicode benchmark run
```

The adapter intentionally lives in the benchmark layer. It does not import or
special-case minicode product internals.

## Local Smoke

From a Harbor checkout, run a local task with:

```bash
export PYTHONPATH=/path/to/minicode
harbor run \
  --path /path/to/task \
  --agent-import-path benchmarks.harbor.minicode_agent:MinicodeAgent \
  --model openai/gpt-5
```

For OpenRouter-backed runs, export:

```bash
export OPENROUTER_API_KEY=...
```

By default, OpenAI-compatible model IDs run through OpenRouter at
`https://openrouter.ai/api/v1`. Set `MINICODE_HARBOR_PROVIDER`,
`MINICODE_HARBOR_BASE_URL`, or direct provider credentials to override that.

For local adapter development before the next npm release, pack this repository
and serve the tarball to the Harbor task container:

```bash
npm run build
npm pack --pack-destination /tmp
cd /tmp && python3 -m http.server 18081 --bind 0.0.0.0
```

Then point the adapter at that tarball:

```bash
export PYTHONPATH=/path/to/minicode
harbor run \
  --path /path/to/harbor/examples/tasks/hello-world \
  --agent-import-path benchmarks.harbor.minicode_agent:MinicodeAgent \
  --model openai/gpt-5 \
  --agent-kwarg provider=openrouter \
  --agent-kwarg package_spec=http://host.docker.internal:18081/sean.holung-minicode-0.2.0.tgz
```

The successful smoke run for this adapter used Harbor's `hello-world` task and
returned reward `1.0`. The published npm package must include
`minicode benchmark run --out` support before the default package install path
works for this adapter.

## Useful Overrides

- `MINICODE_HARBOR_PACKAGE_SPEC`: npm package spec to install. Defaults to
  `@sean.holung/minicode`. This may also be an npm tarball URL for local smoke
  testing.
- `MINICODE_HARBOR_INSTALL_COMMAND`: full install command for local adapter
  development.
- `MINICODE_HARBOR_PROVIDER`: `openrouter`, `openai`, `openai-compatible`, or
  `anthropic`.
- `MINICODE_HARBOR_BASE_URL`: OpenAI-compatible base URL.
- `MINICODE_BENCHMARK_CONFIG`: path passed to `--config`.
- `MINICODE_BENCHMARK_ENV_FILE`: path passed to `--env-file`.
- `MINICODE_BENCHMARK_MAX_STEPS`: forwarded as `MAX_STEPS`.
- `MINICODE_BENCHMARK_MAX_CONTEXT_TOKENS`: forwarded as `MAX_CONTEXT_TOKENS`.
- `MINICODE_BENCHMARK_MODEL_TIMEOUT_SECONDS`: forwarded as
  `MODEL_TIMEOUT_SECONDS`.
- `MINICODE_BENCHMARK_COMMAND_TIMEOUT_MS`: forwarded as `COMMAND_TIMEOUT_MS`.
- `MINICODE_BENCHMARK_MAX_TOOL_OUTPUT_CHARS`: forwarded as
  `MAX_TOOL_OUTPUT_CHARS`.

## Outputs

Each Harbor run writes minicode artifacts under `/logs/agent`:

- `minicode-result.json`
- `minicode.patch`
- `minicode.stdout`

After the run, the adapter downloads `minicode-result.json` into Harbor's agent
logs directory and hydrates `AgentContext.metadata` with model, provider,
changed-file, diff, and tool-usage metadata.
