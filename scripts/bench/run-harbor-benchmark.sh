#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

MODEL_NAME="${MODEL_NAME:-${1:-}}"
if [[ -z "${MODEL_NAME}" ]]; then
  echo "MODEL_NAME is required, in provider/model-id format" >&2
  exit 1
fi

DATASET_NAME="${DATASET_NAME:-swebench-verified}"
DATASET_VERSION="${DATASET_VERSION:-1.0}"
HARBOR_REF="${HARBOR_REF:-main}"
HARBOR_GIT_URL="${HARBOR_GIT_URL:-https://github.com/harbor-framework/harbor.git}"
HARBOR_DIR="${HARBOR_DIR:-${RUNNER_TEMP:-$REPO_ROOT/.tmp}/harbor}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/benchmark-runs/harbor}"
RUN_ID="${RUN_ID:-${DATASET_NAME//[^a-zA-Z0-9_-]/-}-$(date +%Y%m%d-%H%M%S)}"
N_CONCURRENT="${N_CONCURRENT:-1}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
N_TASKS="${N_TASKS:-1}"
TASK_NAMES="${TASK_NAMES:-}"
TIMEOUT_MULTIPLIER="${TIMEOUT_MULTIPLIER:-1.0}"
HARBOR_MAX_RETRIES="${HARBOR_MAX_RETRIES:-0}"
HARBOR_RETRY_INCLUDE="${HARBOR_RETRY_INCLUDE:-}"
HARBOR_RETRY_EXCLUDE="${HARBOR_RETRY_EXCLUDE:-}"
KBENCH_CLI_PATH="${KBENCH_CLI_PATH:-$REPO_ROOT/.bench/kbench.cjs}"
KBENCH_HARNESS="${KBENCH_HARNESS:-kode-agent-sdk}"
AGENT_IMPORT_PATH="kode_bench.harbor.kbench_harbor_agent:KBenchHarborAgent"
AGENT_NODE_VERSION="${AGENT_NODE_VERSION:-20.19.0}"
KBENCH_BENCHMARK="${KBENCH_BENCHMARK:-swe}"

if ! command -v harbor >/dev/null 2>&1; then
  echo "harbor CLI is required to run Harbor benchmarks." >&2
  exit 1
fi

HARBOR_DIR="$(HARBOR_DIR="$HARBOR_DIR" HARBOR_REF="$HARBOR_REF" HARBOR_GIT_URL="$HARBOR_GIT_URL" bash "$REPO_ROOT/scripts/bench/setup-harbor.sh")"

mkdir -p "$OUTPUT_DIR"

pushd "$REPO_ROOT" >/dev/null
if [[ "${NO_REBUILD:-0}" != "1" ]]; then
  npm run bench:bundle:cli
fi
popd >/dev/null

DATASET_SPEC="$DATASET_NAME"
if [[ -n "$DATASET_VERSION" ]]; then
  DATASET_SPEC="${DATASET_NAME}@${DATASET_VERSION}"
fi

HARBOR_START_HELP="$(
  harbor jobs start --help 2>&1 \
    | sed -E 's/\x1B\[[0-9;]*[A-Za-z]//g' \
    || true
)"
HARBOR_TASK_NAME_OPTION=""
if [[ "$HARBOR_START_HELP" == *"--include-task-name"* ]]; then
  HARBOR_TASK_NAME_OPTION="--include-task-name"
elif [[ "$HARBOR_START_HELP" == *"--task-name"* ]]; then
  HARBOR_TASK_NAME_OPTION="--task-name"
elif [[ "$HARBOR_START_HELP" == *"--task"* ]]; then
  HARBOR_TASK_NAME_OPTION="--task"
fi

CMD=(
  harbor jobs start
  --dataset "$DATASET_SPEC"
  --registry-path "$HARBOR_DIR/registry.json"
  --agent-import-path "$AGENT_IMPORT_PATH"
  --model "$MODEL_NAME"
  --job-name "$RUN_ID"
  --jobs-dir "$OUTPUT_DIR"
  --n-concurrent "$N_CONCURRENT"
  --n-attempts "$N_ATTEMPTS"
  --timeout-multiplier "$TIMEOUT_MULTIPLIER"
  --max-retries "$HARBOR_MAX_RETRIES"
  --agent-kwarg "cli_path=$KBENCH_CLI_PATH"
  --agent-kwarg "harness=$KBENCH_HARNESS"
  --agent-kwarg "benchmark=$KBENCH_BENCHMARK"
  --agent-kwarg "node_version=$AGENT_NODE_VERSION"
  --yes
  --quiet
)

if [[ -n "$TASK_NAMES" ]]; then
  if [[ -z "$HARBOR_TASK_NAME_OPTION" ]]; then
    echo "Unable to determine Harbor task selection option for 'harbor jobs start'." >&2
    exit 1
  fi
  IFS=',' read -r -a TASK_ARRAY <<< "$TASK_NAMES"
  for task_name in "${TASK_ARRAY[@]}"; do
    trimmed="${task_name// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=("$HARBOR_TASK_NAME_OPTION" "$trimmed")
    fi
  done
else
  CMD+=(--n-tasks "$N_TASKS")
fi

if [[ -n "$HARBOR_RETRY_INCLUDE" ]]; then
  IFS=',' read -r -a RETRY_INCLUDE_ARRAY <<< "$HARBOR_RETRY_INCLUDE"
  for exception_type in "${RETRY_INCLUDE_ARRAY[@]}"; do
    trimmed="${exception_type// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=(--retry-include "$trimmed")
    fi
  done
fi

if [[ -n "$HARBOR_RETRY_EXCLUDE" ]]; then
  IFS=',' read -r -a RETRY_EXCLUDE_ARRAY <<< "$HARBOR_RETRY_EXCLUDE"
  for exception_type in "${RETRY_EXCLUDE_ARRAY[@]}"; do
    trimmed="${exception_type// /}"
    if [[ -n "$trimmed" ]]; then
      CMD+=(--retry-exclude "$trimmed")
    fi
  done
fi

export PYTHONPATH="$REPO_ROOT${PYTHONPATH:+:$PYTHONPATH}"
export KODE_BENCH_CLI_PATH="$KBENCH_CLI_PATH"
export KBENCH_HARNESS

printf 'Running Harbor benchmark %s with model %s\n' "$DATASET_SPEC" "$MODEL_NAME"
printf 'Harness: %s\n' "$KBENCH_HARNESS"
if [[ -n "$TASK_NAMES" ]]; then
  printf 'Harbor task selector option: %s\n' "$HARBOR_TASK_NAME_OPTION"
fi
printf 'Run output: %s/%s\n' "$OUTPUT_DIR" "$RUN_ID"
"${CMD[@]}"
