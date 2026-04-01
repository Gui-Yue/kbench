# kbench

Evaluate `SWE`, `TB2`, `Tau`, and `SAE` through a unified `kbench` CLI plus benchmark-specific adapters. Benchmark orchestration stays outside the SDK repo, while harness execution is normalized into one runtime contract.

## Features

- Unified CLI entrypoint: `kbench benchmark`, `kbench harness`, `kbench run`
- Built-in harnesses: `kode-agent-sdk`, `codex`, `claude-code`, `gemini-cli`, `custom-adapter`
- Supports custom adapters plus generated adapter bootstraps for external CLI or SDK harnesses
- Runs `swebench-verified` and `terminal-bench@2.0` through Harbor
- Runs official `tau-bench`
- Runs Kaggle `Standardized Agent Exams (SAE)` through the public HTTP exam API
- Supports GitHub Actions smoke tests and larger benchmark runs
- Produces standardized per-instance artifacts under `instances/<id>/`

## Architecture

```text
                    +---------------------------+
                    | GitHub Actions / Scripts  |
                    | SWE / TB2 / Tau / SAE     |
                    +-------------+-------------+
                                  |
                    +-------------v-------------+
                    | benchmark-specific bridge |
                    | Harbor / Tau / SAE        |
                    +-------------+-------------+
                                  |
                    +-------------v-------------+
                    |         kbench CLI        |
                    | benchmark / harness / run |
                    +------+------+-------------+
                           |      |
          +----------------+      +--------------------------+
          |                                          |       |
 +--------v---------+                    +-----------v--+ +--v------------------+
 | kode-agent-sdk   |                    | CLI harnesses | | custom-adapter      |
 | task + session   |                    | codex/claude/ | | manifest + runner   |
 +--------+---------+                    | gemini-cli    | +--+------------------+
          |                              +------+--------+    |
 +--------v--------------------+                |             |
 | @shareai-lab/kode-sdk       |      +--------v--------+    |
 | provider adapters           |      | local CLI       |    |
 +-----------------------------+      | login/config    |    |
                                      +--------+--------+    |
                                               ^             |
                                               |             |
                                      +--------+--------+    |
                                      | adapter generate |---+
                                      | heuristic repo   |
                                      | inspection       |
                                      +------------------+
```

`adapter generate` is part of the current runtime path for bootstrapping dynamic `custom-adapter` integrations.
Today this generator is heuristic and repository-inspection-based; this repo does not yet ship a built-in remote LLM adapter generator.

## Quick Start

This repository is primarily intended to run benchmarks through GitHub Actions.

1. Configure repository secrets and variables:

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_API` if your OpenAI endpoint needs it
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_BASE_URL` if needed
- `GEMINI_API_KEY`
- `GEMINI_BASE_URL` if needed
- `KAGGLE_AGENT_ID` if you want to reuse a fixed SAE agent identity in Actions
- `KAGGLE_AGENT_API_KEY` if you want to reuse a fixed SAE agent identity in Actions

2. Manually dispatch one of these workflows:

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tb2.yml`
- `.github/workflows/eval-tau.yml`
- `.github/workflows/eval-sae.yml`

3. In the workflow form:

- keep `harness=kode-agent-sdk` for the current GitHub Actions path
- choose exactly one `provider`: `openai`, `anthropic`, or `gemini`
- fill `model` for that provider
- optionally override `base_url` for the selected provider

Provider API keys stay in repository secrets. The dispatch form does not accept secret inputs safely, so keys are not entered manually at runtime.

The workflow run step now invokes `kbench benchmark run ...` directly instead of calling benchmark shell scripts as the top-level entrypoint.

Example:

```text
provider=openai
model=gpt-4.1-mini
```

Recommended first SWE smoke test:

```text
provider=openai
model=gpt-4.1-mini
task_limit=2
shard_count=2
max_parallel_shards=1
n_concurrent=1
n_attempts=1
```

## kbench CLI

Build the bundle first:

```bash
npm ci
npm run typecheck
npm run bench:bundle:cli
npm link
```

After `npm link`, `kbench` is available as a local shell command from this repo package.

Useful commands:

```bash
kbench benchmark list
kbench benchmark run --benchmark swe --harness kode-agent-sdk --model-name glm/glm-5
kbench benchmark run --benchmark sae --harness kode-agent-sdk --model-name glm/glm-5
kbench harness list
kbench harness probe --harness codex
kbench harness validate --harness codex --benchmark swe
kbench adapter profiles
kbench adapter init --type node --name my-runner --out /tmp/my-runner
kbench adapter generate --repo ../my-agent --out /tmp/my-agent-adapter
kbench adapter generate --repo ../my-cli-agent --hint cli-harness --out /tmp/my-cli-agent-adapter
kbench adapter validate --adapter /tmp/my-runner
kbench run --benchmark swe --harness custom-adapter --adapter /tmp/my-runner --instruction "Fix the bug"
kbench run --benchmark swe --harness kode-agent-sdk --model-name glm/glm-5 --instruction "Fix the failing test"
kbench run --benchmark swe --harness codex --model-name openai/gpt-5.3-codex --base-url https://apikey.soxio.me/openai --api-key-env OPENAI_API_KEY --config-mode inherit --instruction "Fix the bug"
```

Top-level help is now a full CLI reference:

```bash
kbench --help
```

The top-level help page currently includes:

- command tree and benchmark list
- built-in harness matrix
- required and optional parameters for `run`, `benchmark run`, `harness *`, and `adapter *`
- parameter types, defaults, and applicability notes
- SAE-specific options
- environment-variable based configuration such as provider credentials and generated CLI-adapter bridge vars
- timeout policy and end-to-end examples

Current built-in harness behavior:

- `kode-agent-sdk`: task mode for `swe`, `tb2`, and `sae`, session mode for `tau`
- `codex`: task mode only
- `claude-code`: task mode only
- `gemini-cli`: experimental task mode only
- `custom-adapter`: task or session mode, depending on the supplied adapter manifest

Current benchmark bridges:

- `swe` / `tb2`: Harbor-based benchmark runners
- `tau`: official tau-bench runner
- `sae`: native Kaggle exam runner inside `kbench`

`sae` benchmark usage:

- requires `--harness kode-agent-sdk`
- requires local credential files by default:
  - `~/.kaggle-agent-id`
  - `~/.kaggle-agent-api-key`
- optional auto-registration:
  - `--sae-register-if-missing true`
  - `--sae-agent-name ...`
  - `--sae-agent-description ...`
  - `--sae-agent-version ...`
  - `--sae-agent-type ...`
- optional API overrides:
  - `--sae-api-base https://www.kaggle.com/api/v1`
  - `--sae-agent-id-file ...`
  - `--sae-api-key-file ...`
  - `--sae-poll-interval-ms 2000`
  - `--sae-timeout-ms 1800000`

Example:

```bash
kbench benchmark run \
  --benchmark sae \
  --harness kode-agent-sdk \
  --model-name glm/glm-5 \
  --sae-register-if-missing false
```

`harness list` currently prints:

- harness id
- driver kind
- supported benchmarks
- short description

`harness probe` now validates key machine-readable features for built-in CLI harnesses:

- `codex`: `exec`, `--json`, sandbox bypass flag
- `claude-code`: `--print`, `--output-format`, `stream-json`, `--permission-mode`
- `gemini-cli`: `--prompt`, `--output-format`, `stream-json`, `--yolo`

Recommended `gemini-cli` invocation:

- prefer `--config-mode isolated`
- use `--api-key-env GEMINI_API_KEY`
- when Gemini requires a local proxy, pass `--proxy-url http://127.0.0.1:7897` or the explicit `--http-proxy/--https-proxy/--all-proxy` flags
- use `--base-url` only when you explicitly need a custom Gemini-compatible endpoint

`harness validate` checks whether a harness/benchmark combination is structurally valid before execution:

- supported benchmark declared by the harness
- required run mode for that benchmark (`task` or `session`)

`adapter init` currently supports:

- `--type cli`
- `--type python`
- `--type node`

Each generated adapter contains:

- `adapter.manifest.json`
- a stub runner entrypoint
- `README.md`
- `adapter.validate.json` when generated through `adapter generate`

`adapter generate` adds one more experimental bootstrap path:

- input: `--repo <local-path-or-url>`
- optional override: `--hint <profile>` where profiles come from `kbench adapter profiles`
- output: a valid stub adapter plus `adapter.generate.json` and an automatic `adapter.validate.json`
- purpose: infer a starting `kind`, `runModes`, supported benchmarks, and likely command candidates
- report fields now include `commandDetails`, `recommendedCommand`, and `candidateEntrypoints` to make manual bridge wiring faster

Current built-in generate profiles:

- `generic`: conservative fallback bootstrap
- `cli-harness`: bootstrap for external CLI harnesses such as Codex, Claude Code, Gemini CLI, or similar command-based agents
- `codex`
- `claude-code`
- `gemini-cli`
- `langchain-runner`
- `kode-agent-sdk`

`cli-harness` is intended for repositories that expose a local or globally installed command instead of a stable SDK surface.
The generated adapter validates successfully by default because its `runner.sh` starts in stub mode and only bridges to the real CLI when environment overrides are provided.
This is the current dynamic-adapter path in-repo: `repo inspection -> generated custom-adapter scaffold -> manual wiring or local refinement`.

`cli-harness` bridge environment variables:

- `KBENCH_CLI_COMMAND`: full command used to invoke the target CLI harness
- `KBENCH_CLI_PROMPT_FLAG`: prompt flag name, for example `--prompt`
- `KBENCH_CLI_MODEL_FLAG`: model flag name, for example `--model`
- `KBENCH_CLI_OUTPUT_FLAG`: output-format flag name, for example `--output-format`
- `KBENCH_CLI_OUTPUT_VALUE`: output-format value passed together with the output flag, default `text`
- `KBENCH_CLI_EXTRA_ARGS`: extra raw arguments appended after the inferred flags

Example:

```bash
KBENCH_CLI_COMMAND="my-agent" \
KBENCH_CLI_PROMPT_FLAG="--prompt" \
KBENCH_CLI_MODEL_FLAG="--model" \
KBENCH_CLI_OUTPUT_FLAG="--output-format" \
KBENCH_CLI_OUTPUT_VALUE="json" \
KBENCH_CLI_EXTRA_ARGS="--dangerously-skip-permissions" \
kbench run --benchmark swe --harness custom-adapter --adapter /tmp/my-cli-agent-adapter --model-name openai/gpt-5.3-codex --instruction "Fix the bug"
```

Current limitations of `adapter generate`:

- remote URLs are not fetched automatically; URL inputs are treated as lightweight identifiers unless the repo is available locally
- output is a bootstrap scaffold, not a production-ready adapter
- generated command candidates must still be reviewed manually

`adapter validate` currently checks:

- manifest schema
- entry existence and executability when required
- fixture execution for declared `runModes`
- runner output shape against the kbench adapter protocol

`custom-adapter` runtime usage:

- pass `--harness custom-adapter`
- pass `--adapter <path-to-adapter-dir-or-manifest>`
- for task benchmarks, provide `--instruction`
- for session benchmarks such as `tau`, provide `--messages-file` and `--tools-file`

Parameter precedence for CLI harnesses:

- explicit CLI flags such as `--base-url`, `--api-key-env`, `--config-mode`, `--proxy-url`
- environment variables such as `OPENAI_BASE_URL` or `ANTHROPIC_BASE_URL`
- local harness config or login state when running in `inherit` mode
- driver defaults

Default timeouts:

- `swe` / `tb2` with `codex` or `claude-code`: `30min`
- `swe` / `tb2` with `kode-agent-sdk`: `20min`
- `tau`: `5min`

## Outputs

Every `kbench run` writes a standardized run directory:

- `run.json`
- `summary.json`
- `output.jsonl`
- `output_errors.jsonl`
- `instances/<instance-id>/result.json`
- `instances/<instance-id>/native_result.json`
- `instances/<instance-id>/trace/normalized/trajectory.json` when available
- `instances/<instance-id>/trace/native/*` when available
- `instances/<instance-id>/artifacts/*`
- `instances/<instance-id>/artifacts/manifest.json`

`kbench benchmark run --benchmark sae` also writes run-level exam artifacts:

- `artifacts/sae/start_submission.json`
- `artifacts/sae/questions.json`
- `artifacts/sae/answers.json`
- `artifacts/sae/submit_answers.json`
- `artifacts/sae/final_submission.json`
- `artifacts/sae/agent_profile.json`
- `artifacts/sae/registration.json` when auto-registration is used
- `artifacts/sae/benchmark_error.json` on benchmark-level failures

Harbor shard merging also reads the standardized per-instance result path inside each trial artifact:

- `agent/instances/<trial-name>/result.json`

## Custom Adapter Protocol

The generated custom adapter runner should:

- `src/harness/sdk/manifest.ts`
- `src/harness/sdk/protocol.ts`
- `src/harness/sdk/fixtures.ts`
- `src/harness/templates/cli/`
- `src/harness/templates/python_runner/`
- `src/harness/templates/node_runner/`

Runtime transport contract:

- read one JSON input payload from `$KBENCH_ADAPTER_INPUT` when present
- otherwise read one JSON payload from stdin
- write one JSON output payload to stdout

Optional adapter output fields now include:

- `trace.normalized`: inline normalized trace events written to `trace/normalized/trajectory.json`
- `trace.native`: file references copied into `trace/native/*`

The current Phase 3 scope now covers:

- `adapter init`
- `adapter validate`
- `run --harness custom-adapter --adapter ...`

Experimental bootstrap now also exists:

- `adapter generate`

## Chinese Version

See `README.zh-CN.md`.
