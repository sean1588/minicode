#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CCBENCH_PATH="${CCBENCH_PATH:-/tmp/ccbench}"
HARBOR_BIN="${HARBOR_BIN:-/tmp/harbor-framework/.venv/bin/harbor}"
CCBENCH_JOBS_DIR="${CCBENCH_JOBS_DIR:-/tmp/minicode-ccbench-jobs}"
CCBENCH_MODEL="${CCBENCH_MODEL:-anthropic/claude-sonnet-4.6}"
CCBENCH_PROVIDER="${CCBENCH_PROVIDER:-openrouter}"
CCBENCH_ENV_FILE="${CCBENCH_ENV_FILE:-$HOME/.minicode/.env}"
CCBENCH_PACKAGE_SPEC="${CCBENCH_PACKAGE_SPEC:-@sean.holung/minicode}"
CCBENCH_MAX_CONTEXT_TOKENS="${CCBENCH_MAX_CONTEXT_TOKENS:-100000}"
CCBENCH_MODEL_TIMEOUT_SECONDS="${CCBENCH_MODEL_TIMEOUT_SECONDS:-180}"
CCBENCH_N_CONCURRENT="${CCBENCH_N_CONCURRENT:-1}"

if [[ ! -d "${CCBENCH_PATH}/.git" ]]; then
  git clone https://github.com/codecrafters-io/ccbench.git "${CCBENCH_PATH}"
else
  git -C "${CCBENCH_PATH}" pull --ff-only
fi

if [[ ! -x "${HARBOR_BIN}" ]]; then
  echo "Harbor CLI not found at ${HARBOR_BIN}." >&2
  echo "Set HARBOR_BIN to a Harbor executable before running this script." >&2
  exit 1
fi

ARGS=(
  run
  --path "${CCBENCH_PATH}/tasks"
  --include-task-name "*javascript*"
  --include-task-name "*typescript*"
  --agent-import-path "benchmarks.harbor.minicode_agent:MinicodeAgent"
  --model "${CCBENCH_MODEL}"
  --agent-kwarg "provider=${CCBENCH_PROVIDER}"
  --agent-kwarg "package_spec=${CCBENCH_PACKAGE_SPEC}"
  --agent-kwarg "max_context_tokens=${CCBENCH_MAX_CONTEXT_TOKENS}"
  --agent-kwarg "model_timeout_seconds=${CCBENCH_MODEL_TIMEOUT_SECONDS}"
  --jobs-dir "${CCBENCH_JOBS_DIR}"
  --n-concurrent "${CCBENCH_N_CONCURRENT}"
  --yes
)

if [[ -n "${CCBENCH_ENV_FILE}" ]]; then
  ARGS+=(--env-file "${CCBENCH_ENV_FILE}")
fi

export PYTHONPATH="${REPO_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
exec "${HARBOR_BIN}" "${ARGS[@]}" "$@"
