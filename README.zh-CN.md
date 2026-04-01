# kbench

通过统一的 `kbench` CLI 加上 benchmark 适配层来评测 `SWE`、`TB2`、`Tau`、`SAE`。benchmark 编排留在这个仓库里，harness 执行统一收口到一套运行时协议。

## Features

- 统一 CLI 入口：`kbench benchmark`、`kbench harness`、`kbench run`
- 内置 harness：`kode-agent-sdk`、`codex`、`claude-code`、`gemini-cli`、`custom-adapter`
- 支持自定义 adapter，以及面向外部 CLI / SDK harness 的 adapter bootstrap 生成
- 通过 Harbor 跑 `swebench-verified` 和 `terminal-bench@2.0`
- 运行官方 `tau-bench`
- 通过 Kaggle 公共 HTTP exam API 运行 `Standardized Agent Exams (SAE)`
- 支持 GitHub Actions 冒烟测试和更大规模评测
- 标准化输出到 `instances/<id>/` 目录

## 架构图

```text
                    +---------------------------+
                    | GitHub Actions / Scripts  |
                    | SWE / TB2 / Tau / SAE     |
                    +-------------+-------------+
                                  |
                    +-------------v-------------+
                    | benchmark 专用桥接层     |
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
 | provider adapters           |      | 本机 CLI 运行时 |    |
 +-----------------------------+      | 登录态/配置     |    |
                                      +--------+--------+    |
                                               ^             |
                                               |             |
                                      +--------+--------+    |
                                      | adapter generate |---+
                                      | 启发式仓库分析    |
                                      | bootstrap        |
                                      +------------------+
```

`adapter generate` 已经是当前仓库里动态 `custom-adapter` bootstrap 的一部分。
但当前实现仍然是基于本地仓库检查和启发式推断，不是“仓库内置远程 LLM 动态生成 adapter”。

## Quick Start

这个仓库的主要用法仍然是通过 GitHub Actions 发起评测。

1. 先配置仓库 secrets 和 variables：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- 如果你的 OpenAI 接口需要，再配置 `OPENAI_API`
- `ANTHROPIC_API_KEY`
- 如果需要，再配置 `ANTHROPIC_BASE_URL`
- `GEMINI_API_KEY`
- 如果需要，再配置 `GEMINI_BASE_URL`
- 如果希望在 Actions 里复用固定的 SAE agent 身份，再配置 `KAGGLE_AGENT_ID`
- 如果希望在 Actions 里复用固定的 SAE agent 身份，再配置 `KAGGLE_AGENT_API_KEY`

2. 手动 dispatch 这些 workflow 之一：

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tb2.yml`
- `.github/workflows/eval-tau.yml`
- `.github/workflows/eval-sae.yml`

3. 在 workflow 表单里：

- 当前 GitHub Actions 路径下，`harness` 固定选择 `kode-agent-sdk`
- 必须从 `openai`、`anthropic`、`gemini` 里单选一个 `provider`
- 填这个 provider 对应的 `model`
- 如果需要，可以填写这个 provider 的 `base_url`

provider 的 API key 继续放在 GitHub 仓库 secrets 里。dispatch 表单不适合安全地手动输入 secret，所以不会在运行时直接填 key。

现在 workflow 的实际执行入口已经改成直接调用 `kbench benchmark run ...`，而不是在最外层直接调用 benchmark shell 脚本。

例如：

```text
provider=openai
model=gpt-4.1-mini
```

推荐先做一个 SWE 冒烟测试：

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

先构建 bundle：

```bash
npm ci
npm run typecheck
npm run bench:bundle:cli
npm link
```

执行 `npm link` 后，这个仓库会在本机暴露出 `kbench` 命令。

常用命令：

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

现在顶层帮助已经是一份完整的 CLI 参考手册：

```bash
kbench --help
```

当前顶层帮助页会覆盖：

- 命令树和 benchmark 列表
- 内置 harness 能力矩阵
- `run`、`benchmark run`、`harness *`、`adapter *` 的必填/可选参数
- 参数类型、默认值和适用范围说明
- SAE 专用参数
- 基于环境变量的配置项，例如 provider 凭证和生成型 CLI adapter 的桥接变量
- timeout 策略和端到端示例

当前内置 harness 能力：

- `kode-agent-sdk`：支持 `swe`、`tb2`、`sae` 的 task 模式，以及 `tau` 的 session 模式
- `codex`：当前只支持 task 模式
- `claude-code`：当前只支持 task 模式
- `gemini-cli`：实验性支持 task 模式
- `custom-adapter`：是否支持 task / session 取决于传入 adapter manifest 的声明

当前 benchmark bridge：

- `swe` / `tb2`：基于 Harbor 的 benchmark runner
- `tau`：官方 tau-bench runner
- `sae`：`kbench` 内置的 Kaggle exam runner

`sae` benchmark 的使用约束：

- 当前要求 `--harness kode-agent-sdk`
- 默认从本地 credential 文件读取：
  - `~/.kaggle-agent-id`
  - `~/.kaggle-agent-api-key`
- 可选自动注册：
  - `--sae-register-if-missing true`
  - `--sae-agent-name ...`
  - `--sae-agent-description ...`
  - `--sae-agent-version ...`
  - `--sae-agent-type ...`
- 可选 API 覆盖：
  - `--sae-api-base https://www.kaggle.com/api/v1`
  - `--sae-agent-id-file ...`
  - `--sae-api-key-file ...`
  - `--sae-poll-interval-ms 2000`
  - `--sae-timeout-ms 1800000`

示例：

```bash
kbench benchmark run \
  --benchmark sae \
  --harness kode-agent-sdk \
  --model-name glm/glm-5 \
  --sae-register-if-missing false
```

`harness list` 当前会输出：

- harness id
- driver 类型
- 支持的 benchmark
- 简短描述

`harness probe` 现在会校验内置 CLI harness 的关键机器可读能力：

- `codex`：`exec`、`--json`、sandbox bypass flag
- `claude-code`：`--print`、`--output-format`、`stream-json`、`--permission-mode`
- `gemini-cli`：`--prompt`、`--output-format`、`stream-json`、`--yolo`

推荐的 `gemini-cli` 用法：

- 优先使用 `--config-mode isolated`
- 通过 `--api-key-env GEMINI_API_KEY` 传 key
- 如果 Gemini 需要本地代理，可传 `--proxy-url http://127.0.0.1:7897`，或显式传 `--http-proxy/--https-proxy/--all-proxy`
- 只有在你明确需要自定义 Gemini 兼容端点时再传 `--base-url`

`harness validate` 会在真正执行前检查 harness 和 benchmark 组合是否合法：

- harness 是否声明支持该 benchmark
- 该 benchmark 所需的 run mode（`task` 或 `session`）是否满足

`adapter init` 当前支持：

- `--type cli`
- `--type python`
- `--type node`

每次生成的 adapter 目录都会包含：

- `adapter.manifest.json`
- 一个 stub runner 入口文件
- `README.md`
- 通过 `adapter generate` 生成时，还会附带 `adapter.validate.json`

`adapter generate` 额外提供了一条实验性的 bootstrap 路径：

- 输入：`--repo <本地路径或URL>`
- 可选覆盖：`--hint <profile>`，可通过 `kbench adapter profiles` 查看内置画像
- 输出：一个可直接 `validate` 的 stub adapter，加上一份 `adapter.generate.json` 和自动生成的 `adapter.validate.json`
- 作用：推断初始 `kind`、`runModes`、支持的 benchmark，以及可能的命令候选
- 报告里还会包含 `commandDetails`、`recommendedCommand`、`candidateEntrypoints`，方便人工接线时快速定位真实入口

当前内置的 generate profile：

- `generic`：保守兜底 bootstrap
- `cli-harness`：面向外部 CLI harness 的 bootstrap，适合 Codex、Claude Code、Gemini CLI 这类命令式 agent
- `codex`
- `claude-code`
- `gemini-cli`
- `langchain-runner`
- `kode-agent-sdk`

`cli-harness` 适用于“仓库暴露的是本地或全局 CLI 命令，而不是稳定 SDK 接口”的场景。
生成出的 adapter 默认能通过 `validate`，因为 `runner.sh` 初始运行在 stub 模式；只有提供了环境变量覆盖后，才会桥接到真实 CLI。
这也是当前仓库里“动态 adapter”能力的实际落地路径：`仓库检查 -> 生成 custom-adapter 骨架 -> 人工接线或本地细化`。

`cli-harness` 桥接环境变量：

- `KBENCH_CLI_COMMAND`：调用目标 CLI harness 的完整命令
- `KBENCH_CLI_PROMPT_FLAG`：prompt 参数名，例如 `--prompt`
- `KBENCH_CLI_MODEL_FLAG`：model 参数名，例如 `--model`
- `KBENCH_CLI_OUTPUT_FLAG`：输出格式参数名，例如 `--output-format`
- `KBENCH_CLI_OUTPUT_VALUE`：和输出格式参数一起传入的值，默认 `text`
- `KBENCH_CLI_EXTRA_ARGS`：附加到推断参数后的原始额外参数

示例：

```bash
KBENCH_CLI_COMMAND="my-agent" \
KBENCH_CLI_PROMPT_FLAG="--prompt" \
KBENCH_CLI_MODEL_FLAG="--model" \
KBENCH_CLI_OUTPUT_FLAG="--output-format" \
KBENCH_CLI_OUTPUT_VALUE="json" \
KBENCH_CLI_EXTRA_ARGS="--dangerously-skip-permissions" \
kbench run --benchmark swe --harness custom-adapter --adapter /tmp/my-cli-agent-adapter --model-name openai/gpt-5.3-codex --instruction "Fix the bug"
```

`adapter generate` 当前限制：

- 对远程 URL 不会自动拉取仓库；如果本地没有源码，只会把 URL 当作轻量标识做推断
- 生成结果只是 bootstrap 骨架，不是可直接上榜的正式 adapter
- 推断出的命令候选仍需要人工确认和修改

`adapter validate` 当前会检查：

- manifest schema
- entry 是否存在，必要时是否可执行
- 对声明的 `runModes` 跑 fixture 执行校验
- runner 输出是否符合 kbench adapter 协议

`custom-adapter` 运行方式：

- 传 `--harness custom-adapter`
- 传 `--adapter <adapter目录或manifest路径>`
- 对 task benchmark，提供 `--instruction`
- 对 `tau` 这类 session benchmark，提供 `--messages-file` 和 `--tools-file`

CLI harness 参数优先级：

- 显式命令行参数，例如 `--base-url`、`--api-key-env`、`--config-mode`、`--proxy-url`
- 环境变量，例如 `OPENAI_BASE_URL`、`ANTHROPIC_BASE_URL`
- `inherit` 模式下本机已有登录态或本地配置
- driver 默认值

默认超时：

- `codex` / `claude-code` 跑 `swe`、`tb2`：`30min`
- `kode-agent-sdk` 跑 `swe`、`tb2`：`20min`
- `tau`：`5min`

## Outputs

每次 `kbench run` 都会写出统一目录结构：

- `run.json`
- `summary.json`
- `output.jsonl`
- `output_errors.jsonl`
- `instances/<instance-id>/result.json`
- `instances/<instance-id>/native_result.json`
- `instances/<instance-id>/trace/normalized/trajectory.json`，如果 adapter 提供了规范化 trace
- `instances/<instance-id>/trace/native/*`，如果 adapter 提供了原生 trace
- `instances/<instance-id>/artifacts/*`
- `instances/<instance-id>/artifacts/manifest.json`

`kbench benchmark run --benchmark sae` 还会额外写出 run 级 exam artifacts：

- `artifacts/sae/start_submission.json`
- `artifacts/sae/questions.json`
- `artifacts/sae/answers.json`
- `artifacts/sae/submit_answers.json`
- `artifacts/sae/final_submission.json`
- `artifacts/sae/agent_profile.json`
- 如果使用自动注册，还会有 `artifacts/sae/registration.json`
- 如果发生 benchmark 级失败，还会有 `artifacts/sae/benchmark_error.json`

Harbor 的 shard 合并脚本也统一读取 trial artifact 里的标准结果路径：

- `agent/instances/<trial-name>/result.json`

## 自定义 Adapter 协议

生成出来的自定义 adapter runner 需要遵守下面的输入输出约定：

- `src/harness/sdk/manifest.ts`
- `src/harness/sdk/protocol.ts`
- `src/harness/sdk/fixtures.ts`
- `src/harness/templates/cli/`
- `src/harness/templates/python_runner/`
- `src/harness/templates/node_runner/`

运行时传输约定：

- 如果存在 `$KBENCH_ADAPTER_INPUT`，优先从该文件读取一份 JSON 输入
- 否则从 stdin 读取一份 JSON 输入
- 向 stdout 写出一份 JSON 输出

当前也支持可选 trace 输出：

- `trace.normalized`：直接返回规范化 trace events，`kbench` 会落到 `trace/normalized/trajectory.json`
- `trace.native`：返回原生 trace 文件引用，`kbench` 会复制到 `trace/native/*`

当前 Phase 3 的范围已经覆盖：

- `adapter init`
- `adapter validate`
- `run --harness custom-adapter --adapter ...`

当前也已经补上了实验性的 bootstrap 能力：

- `adapter generate`

## English Version

见 `README.md`。
