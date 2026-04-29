#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_BENCH_PATH="${TS_BENCH_PATH:-/tmp/ts-bench}"
TS_BENCH_EXERCISE="${TS_BENCH_EXERCISE:-25}"
TS_BENCH_PROVIDER="${TS_BENCH_PROVIDER:-openrouter}"
TS_BENCH_MODEL="${TS_BENCH_MODEL:-google/gemini-3-flash-preview}"
TS_BENCH_ENV_FILE="${TS_BENCH_ENV_FILE:-$HOME/.minicode/.env}"
TS_BENCH_INSTALL_DEPS="${TS_BENCH_INSTALL_DEPS:-1}"
TS_BENCH_SKIP_BUILD="${TS_BENCH_SKIP_BUILD:-0}"
export TMPDIR="${TMPDIR:-/tmp}"
export TEMP="${TEMP:-$TMPDIR}"
export TMP="${TMP:-$TMPDIR}"

if [[ ! -d "${TS_BENCH_PATH}/.git" ]]; then
  git clone https://github.com/laiso/ts-bench.git "${TS_BENCH_PATH}"
fi

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "${HOME}/.nvm/nvm.sh"
  nvm use 22 >/dev/null
fi

ARGS=(
  --ts-bench-path "${TS_BENCH_PATH}"
  --exercise "${TS_BENCH_EXERCISE}"
  --provider "${TS_BENCH_PROVIDER}"
  --model "${TS_BENCH_MODEL}"
)

if [[ -n "${TS_BENCH_ENV_FILE}" ]]; then
  ARGS+=(--env-file "${TS_BENCH_ENV_FILE}")
fi

if [[ "${TS_BENCH_INSTALL_DEPS}" == "1" ]]; then
  ARGS+=(--install-deps)
fi

if [[ "${TS_BENCH_SKIP_BUILD}" == "1" ]]; then
  ARGS+=(--skip-build)
fi

exec node --import tsx "${REPO_ROOT}/scripts/run-ts-bench-smoke.ts" "${ARGS[@]}" "$@"
