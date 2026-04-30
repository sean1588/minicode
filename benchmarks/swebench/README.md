# SWE-bench Verified

This directory documents running `minicode` against
[`SWE-bench Verified`](https://www.swebench.com/) through Harbor.

SWE-bench Verified evaluates real bug-fixing work in Python repositories. The
Harbor SWE-bench adapter provides the task environments and verifier; minicode
runs through the generic Harbor adapter in [`benchmarks/harbor`](../harbor/README.md).
The integration stays in the benchmark layer and does not special-case product
internals.

## Run

Use the wrapper from the repository root:

```bash
npm run benchmark:swebench
```

The wrapper defaults to a single-task smoke run from the registered
`swebench-verified` dataset and writes Harbor jobs under
`/tmp/minicode-swebench-jobs`.

Default settings:

- provider: `openrouter`
- model: `openai/gpt-5.4`
- dataset: `swebench-verified`
- task limit: `1`
- context: `100000` tokens
- model start timeout: `180` seconds
- concurrency: `1`
- env file: `~/.minicode/.env`

Override with environment variables:

```bash
SWEBENCH_MODEL=openai/gpt-5.4 \
SWEBENCH_N_TASKS=5 \
SWEBENCH_JOB_NAME=gpt-5-4-swebench-smoke-5 \
npm run benchmark:swebench
```

Filter to a specific task name if needed:

```bash
SWEBENCH_INCLUDE_TASK_NAME='*django*' \
SWEBENCH_N_TASKS=1 \
npm run benchmark:swebench
```

For local unpublished changes, build and serve a tarball:

```bash
source ~/.nvm/nvm.sh
nvm use 22 >/dev/null
npm run build
npm pack --pack-destination /tmp
cd /tmp && python3 -m http.server 18081 --bind 0.0.0.0
```

Then run:

```bash
SWEBENCH_PACKAGE_SPEC=http://host.docker.internal:18081/sean.holung-minicode-0.2.0.tgz \
npm run benchmark:swebench
```

## Notes

- The full SWE-bench Verified set has 500 tasks and can be expensive. Start
  with `SWEBENCH_N_TASKS=1` or a curated subset before a full run.
- SWE-bench tasks are Python-heavy, so this lane requires the Python plugin to
  be included in the minicode package under test.
- Results should list provider, model, package source, context limit, task
  count, runtime, and exceptions so future comparisons are honest.

## Result Log

Recorded minicode results live in [`RESULTS.md`](./RESULTS.md).
