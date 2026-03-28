# kbench

通过独立 benchmark adapter 层评测 KODE 在 `SWE`、`TB2`、`Tau` 上的表现，而不把 benchmark 逻辑耦合进 SDK 主仓库。

## Features

- 通过 Harbor 运行 `swebench-verified`
- 通过 Harbor 运行 `terminal-bench@2.0`
- 运行官方 `tau-bench`
- 通过 npm 包 `@shareai-lab/kode-sdk` 调用 KODE
- benchmark 框架在运行时动态拉取
- 支持 GitHub Actions 冒烟测试和更大规模评测
- 产出汇总报告和按题拆分的结果文件

## Quick Start

这个仓库的主要使用方式是通过 GitHub Actions 发起评测。

1. 先配置仓库 secrets 和 variables：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- 如果你的 provider 需要，再配置 `OPENAI_API`
- 其他可选 provider key，例如 `ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`MINIMAX_API_KEY`

2. 打开 Actions 页面，手动 dispatch 这些 workflow 之一：

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tb2.yml`
- `.github/workflows/eval-tau.yml`

3. 下面两种方式二选一：

- 直接传 `provider/model` 格式的 `model_name`
- 或者分别传 `provider` 和 `model`

如果是 OpenAI-compatible provider，还可以在触发时直接填写 `base_url`。

例如：

```text
glm/glm-5
```

推荐先做一个 SWE 冒烟测试：

```text
model_name=glm/glm-5
task_limit=2
shard_count=2
max_parallel_shards=1
n_concurrent=1
n_attempts=1
```

## 架构图

```text
            +----------------------+
            |  GitHub Actions      |
            |  SWE / TB2 / Tau     |
            +----------+-----------+
                       |
          +------------+-------------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Harbor 路径   |          | Tau 路径      |
  | SWE / TB2     |          | Tau           |
  +-------+-------+          +-------+-------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Harbor Adapter|          | Tau Adapter   |
  +-------+-------+          +-------+-------+
          |                          |
          v                          v
  +---------------+          +---------------+
  | Node Runner   |          | Step Runner   |
  +-------+-------+          +-------+-------+
          \____________________  ____________/
                               \/
                    +----------------------+
                    | @shareai-lab/kode-sdk|
                    +----------------------+
```

## Run on GitHub Actions

手动 dispatch 这些 workflow：

- `.github/workflows/eval-swe.yml`
- `.github/workflows/eval-tb2.yml`
- `.github/workflows/eval-tau.yml`

最基本的输入：

```text
provider=glm
model=glm-5
```

常见仓库配置：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `OPENAI_API`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `MINIMAX_API_KEY`

如果走 OpenAI-compatible 的 GLM 路由，实际读取的是：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`，除非你在 workflow dispatch 页面直接填写了 `base_url`

常用 workflow 输入：

### SWE / TB2

- `model_name`
- `provider`
- `model`
- `base_url`
- `task_names`
- `task_limit`
- `shard_count`
- `max_parallel_shards`
- `n_attempts`
- `n_concurrent`

### Tau

- `model_name`
- `provider`
- `model`
- `base_url`
- `tau_env`
- `task_split`
- `task_ids`
- `start_index`
- `end_index`
- `num_trials`
- `max_concurrency`

## 本地执行状态

本地开发目前支持校验和构建，但还不是主要评测入口。

当前本地支持：

- `npm ci`
- `npm run typecheck`
- `npm run bench:bundle:harbor`
- `npm run bench:bundle:tau`
- Harbor 和 Tau 的动态拉取 smoke 检查

当前还不把下面这些当成稳定的本地评测接口：

- 一条命令完整跑 SWE
- 一条命令完整跑 TB2
- 一条命令完整跑 Tau

如果你要稳定、可复现地执行 benchmark，优先走 GitHub Actions。

## Outputs

### SWE / TB2

每次 run 会产出：

- shard artifacts
- 每题的 `result.json`
- `agent/kode-result.json`
- 合并后的 summary markdown
- 合并后的 results JSON
- 合并后的 per-test details JSON

### Tau

每次 run 会产出：

- 最终 metrics JSON
- 每题 reward 数据
- 每题 trajectory 数据

## English Version

见 `README.md`。
