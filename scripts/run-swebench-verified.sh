#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARBOR_BIN="${HARBOR_BIN:-/tmp/harbor-framework/.venv/bin/harbor}"
SWEBENCH_DATASET="${SWEBENCH_DATASET:-swebench-verified}"
SWEBENCH_JOBS_DIR="${SWEBENCH_JOBS_DIR:-/tmp/minicode-swebench-jobs}"
SWEBENCH_MODEL="${SWEBENCH_MODEL:-openai/gpt-5.4}"
SWEBENCH_PROVIDER="${SWEBENCH_PROVIDER:-openrouter}"
SWEBENCH_ENV_FILE="${SWEBENCH_ENV_FILE:-$HOME/.minicode/.env}"
SWEBENCH_PACKAGE_SPEC="${SWEBENCH_PACKAGE_SPEC:-@sean.holung/minicode}"
SWEBENCH_MAX_CONTEXT_TOKENS="${SWEBENCH_MAX_CONTEXT_TOKENS:-100000}"
SWEBENCH_MODEL_TIMEOUT_SECONDS="${SWEBENCH_MODEL_TIMEOUT_SECONDS:-180}"
SWEBENCH_N_CONCURRENT="${SWEBENCH_N_CONCURRENT:-1}"
SWEBENCH_N_TASKS="${SWEBENCH_N_TASKS:-1}"
SWEBENCH_JOB_NAME="${SWEBENCH_JOB_NAME:-}"
SWEBENCH_INCLUDE_TASK_NAME="${SWEBENCH_INCLUDE_TASK_NAME:-}"
SWEBENCH_EXCLUDE_TASK_NAME="${SWEBENCH_EXCLUDE_TASK_NAME:-}"

if [[ ! -x "${HARBOR_BIN}" ]]; then
  echo "Harbor CLI not found at ${HARBOR_BIN}." >&2
  echo "Set HARBOR_BIN to a Harbor executable before running this script." >&2
  exit 1
fi

ARGS=(
  run
  --dataset "${SWEBENCH_DATASET}"
  --agent-import-path "benchmarks.harbor.minicode_agent:MinicodeAgent"
  --model "${SWEBENCH_MODEL}"
  --agent-kwarg "provider=${SWEBENCH_PROVIDER}"
  --agent-kwarg "package_spec=${SWEBENCH_PACKAGE_SPEC}"
  --agent-kwarg "max_context_tokens=${SWEBENCH_MAX_CONTEXT_TOKENS}"
  --agent-kwarg "model_timeout_seconds=${SWEBENCH_MODEL_TIMEOUT_SECONDS}"
  --jobs-dir "${SWEBENCH_JOBS_DIR}"
  --n-concurrent "${SWEBENCH_N_CONCURRENT}"
  --yes
)

if [[ -n "${SWEBENCH_N_TASKS}" ]]; then
  ARGS+=(--n-tasks "${SWEBENCH_N_TASKS}")
fi

if [[ -n "${SWEBENCH_JOB_NAME}" ]]; then
  ARGS+=(--job-name "${SWEBENCH_JOB_NAME}")
fi

if [[ -n "${SWEBENCH_INCLUDE_TASK_NAME}" ]]; then
  ARGS+=(--include-task-name "${SWEBENCH_INCLUDE_TASK_NAME}")
fi

if [[ -n "${SWEBENCH_EXCLUDE_TASK_NAME}" ]]; then
  ARGS+=(--exclude-task-name "${SWEBENCH_EXCLUDE_TASK_NAME}")
fi

if [[ -n "${SWEBENCH_ENV_FILE}" ]]; then
  ARGS+=(--env-file "${SWEBENCH_ENV_FILE}")
fi

export PYTHONPATH="${REPO_ROOT}${PYTHONPATH:+:${PYTHONPATH}}"
exec "${HARBOR_BIN}" "${ARGS[@]}" "$@"
