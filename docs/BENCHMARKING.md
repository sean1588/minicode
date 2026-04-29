# Benchmarking

`minicode benchmark run` is the stable non-interactive entrypoint for external benchmark harnesses.

Unlike the normal CLI and web UI flows, benchmark mode does **not** read `~/.minicode/.env` by default. This keeps runs reproducible and avoids leaking a developer's local interactive config into benchmark jobs.

Benchmark mode also adds benchmark-specific execution guidance:

- the task is already approved
- the agent should not ask for confirmation before editing
- the agent should finish the task instead of stopping after a plan
- if a model still ends with an approval-seeking completion, minicode retries once with a stronger reminder

## Command

```bash
minicode benchmark run [options] "prompt text"
```

Or, for long benchmark instructions:

```bash
minicode benchmark run [options] --prompt-file prompt.txt
```

## Supported options

- `--config <path>`: Optional benchmark JSON config file. If omitted, minicode will use `./benchmarks/benchmark.config.json` when that file exists under the current working directory.
- `--env-file <path>`: Optional dotenv file. Pass multiple times if needed.
- `--provider <value>`: Explicit model provider override.
- `--model <value>`: Explicit model override.
- `--base-url <value>`: Explicit OpenAI-compatible base URL override.
- `--workspace-root <path>`: Explicit workspace root override.
- `--diff-out <path>`: Write the final git patch to a file.
- `--out <path>`: Write the structured JSON result to a file instead of stdout.
- `--verbose`: Enable verbose agent logging during the run.

## Precedence

Benchmark config is resolved in this order:

1. Hardcoded runtime defaults
2. Benchmark JSON config (`--config` or `./benchmarks/benchmark.config.json`)
3. `--env-file` dotenv files, in the order provided
4. Shell environment variables
5. Explicit CLI overrides (`--provider`, `--model`, `--base-url`, `--workspace-root`)

`~/.minicode/.env` is excluded from this resolution path unless you explicitly pass it through `--env-file ~/.minicode/.env`.

## Benchmark config file

The benchmark config file uses the same runtime concepts as the main CLI, but in JSON form:

```json
{
  "modelProvider": "openai-compatible",
  "model": "google/gemini-3-flash-preview",
  "openAiBaseUrl": "https://openrouter.ai/api/v1",
  "maxSteps": 50,
  "maxContextTokens": 32000,
  "commandTimeoutMs": 30000
}
```

The repository's own benchmark defaults live in [`benchmarks/benchmark.config.json`](../benchmarks/benchmark.config.json).

## Credentials

Recommended patterns:

- Put benchmark-specific secrets in a repo-local or job-local dotenv file and pass it with `--env-file`.
- Or inject secrets through the runner environment (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, etc.).

Avoid relying on `~/.minicode/.env` for benchmark jobs unless you deliberately pass it in.

## Output

Benchmark mode emits structured JSON with:

- final agent text
- token usage, when available
- elapsed time
- resolved workspace root
- resolved provider/model/base URL
- changed files detected from git status, scoped to the selected workspace subtree
- tool-call trace with each tool name, input, result, step, and skipped status
- tool-usage summary for structured tools, file reads, searches, mutations, commands, skipped calls, and repeated-call stops
- whether the workspace is a git repo
- optional diff artifact path

Example:

```bash
minicode benchmark run \
  --config benchmarks/benchmark.config.json \
  --env-file benchmarks/benchmark.env \
  --prompt-file prompt.txt \
  --diff-out artifacts/result.patch \
  --out artifacts/result.json
```

This is the recommended surface for integrating minicode with `ts-bench`, Harbor-based benchmarks like CCBench, and future patch-based evaluators.

For the concrete `ts-bench` workflow, see [`benchmarks/ts-bench/README.md`](../benchmarks/ts-bench/README.md).
For the quick-start wrapper, see [`BENCHMARK.md`](../BENCHMARK.md).
