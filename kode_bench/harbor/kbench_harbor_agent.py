import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class KBenchHarborAgent(BaseInstalledAgent):
    """Run the kbench CLI inside a Harbor task environment."""

    _CONSOLE_FILENAME = "kbench-console.log"

    def __init__(
        self,
        logs_dir: Path,
        cli_path: str | None = None,
        harness: str = "kode-agent-sdk",
        benchmark: str = "swe",
        node_version: str = "20.19.0",
        *args,
        **kwargs,
    ):
        super().__init__(logs_dir=logs_dir, *args, **kwargs)
        self._cli_path = Path(
            cli_path or os.environ.get("KODE_BENCH_CLI_PATH", "")
        ).expanduser()
        self._harness = harness
        self._benchmark = benchmark
        self._node_version = node_version
        self._install_script_path = (
            Path(__file__).parent.parent / "shared" / "install_node.sh"
        )

        if not self._cli_path.exists():
            raise ValueError(
                "kbench CLI bundle was not found. "
                f"Expected: {self._cli_path}"
            )

        if not self._install_script_path.exists():
            raise ValueError(
                "Node install helper script was not found. "
                f"Expected: {self._install_script_path}"
            )

    @staticmethod
    def name() -> str:
        return "kbench-installed-agent"

    def get_version_command(self) -> str | None:
        return "bash -lc 'source /installed-agent/runtime-path.sh && node --version'"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "if command -v apk >/dev/null 2>&1; then "
                "  apk add --no-cache bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "elif command -v apt-get >/dev/null 2>&1; then "
                "  apt-get update >/dev/null 2>&1 && "
                "  DEBIAN_FRONTEND=noninteractive apt-get install -y bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "elif command -v yum >/dev/null 2>&1; then "
                "  yum install -y bash curl python3 tar gzip >/dev/null 2>&1 || true; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

        await environment.upload_file(
            source_path=self._install_script_path,
            target_path="/installed-agent/install_node.sh",
        )
        await environment.upload_file(
            source_path=self._cli_path,
            target_path=f"/installed-agent/{self._cli_path.name}",
        )
        await self.exec_as_root(
            environment,
            command=(
                "chmod +x "
                f"{shlex.quote('/installed-agent/install_node.sh')} "
                f"{shlex.quote(f'/installed-agent/{self._cli_path.name}')}"
            ),
        )

        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"export KODE_NODE_VERSION={shlex.quote(self._node_version)}; "
                "bash /installed-agent/install_node.sh"
            ),
        )

    def _instance_result_path(self, trial_name: str) -> Path:
        return self.logs_dir / "instances" / trial_name / "result.json"

    @staticmethod
    def _get_nested_attr(value: Any, *parts: str) -> Any:
        current = value
        for part in parts:
            if current is None:
                return None
            current = getattr(current, part, None)
        return current

    def _resolve_instance_id(self, context: AgentContext | None) -> str:
        candidates = (
            self._get_nested_attr(context, "trial", "name"),
            getattr(context, "trial_name", None),
            self._get_nested_attr(context, "task", "name"),
            getattr(context, "task_name", None),
            getattr(context, "name", None),
        )
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
        return "kbench-step"

    def _discover_instance_result_path(self, context: AgentContext | None) -> Path | None:
        preferred = self._instance_result_path(self._resolve_instance_id(context))
        if preferred.exists():
            return preferred

        candidates = sorted((self.logs_dir / "instances").glob("*/result.json"))
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            self.logger.warning(
                "Multiple kbench result files found under %s; using %s",
                self.logs_dir / "instances",
                candidates[0],
            )
            return candidates[0]
        return None

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_path = self._discover_instance_result_path(context)
        if result_path is None:
            self.logger.warning(
                "No kbench result file found under %s",
                self.logs_dir / "instances",
            )
            return
        if not result_path.exists():
            self.logger.warning(f"No kbench result file found at {result_path}")
            return

        try:
            payload = json.loads(result_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            self.logger.error(f"Failed to parse kbench result file: {exc}")
            return

        metrics = payload.get("usage") or {}
        error_payload = payload.get("error")
        error_message = (
            error_payload.get("message")
            if isinstance(error_payload, dict)
            else error_payload
        )

        context.n_input_tokens = metrics.get("inputTokens") or metrics.get(
            "input_tokens"
        )
        context.n_output_tokens = metrics.get("outputTokens") or metrics.get(
            "output_tokens"
        )
        context.n_cache_tokens = metrics.get("cacheTokens") or metrics.get(
            "cache_tokens"
        )
        context.cost_usd = metrics.get("costUsd") or metrics.get("cost_usd")
        context.metadata = {
            key: value
            for key, value in {
                "benchmark": payload.get("benchmark"),
                "harness": payload.get("harness"),
                "instance_id": result_path.parent.name,
                "ok": payload.get("ok"),
                "status": payload.get("status"),
                "elapsed_ms": payload.get("elapsedMs"),
                "failure_kind": payload.get("failureKind"),
                "error": error_message,
            }.items()
            if value is not None
        }

    def _build_container_env(self) -> dict[str, str]:
        env: dict[str, str] = {
            "KODE_BENCH_MODEL_NAME": self.model_name or "",
            "KODE_NODE_VERSION": self._node_version,
        }

        passthrough_keys = (
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_PROXY_URL",
            "ANTHROPIC_EXTRA_HEADERS",
            "ANTHROPIC_EXTRA_BODY",
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_PROXY_URL",
            "OPENAI_API",
            "OPENAI_EXTRA_HEADERS",
            "OPENAI_EXTRA_BODY",
            "GEMINI_API_KEY",
            "GEMINI_BASE_URL",
            "GEMINI_PROXY_URL",
            "GEMINI_EXTRA_HEADERS",
            "GEMINI_EXTRA_BODY",
            "MINIMAX_API_KEY",
            "MINIMAX_BASE_URL",
            "MINIMAX_PROXY_URL",
            "MINIMAX_EXTRA_HEADERS",
            "MINIMAX_EXTRA_BODY",
            "KODE_BENCH_RETRY_MAX_ATTEMPTS",
            "KODE_BENCH_RETRY_INITIAL_DELAY_MS",
            "KODE_BENCH_RETRY_MAX_DELAY_MS",
            "KODE_BENCH_RETRY_BACKOFF_MULTIPLIER",
            "KODE_BENCH_RETRY_JITTER_RATIO",
            "KODE_BENCH_STREAMING_MODE",
            "KODE_BENCH_MAX_ROUNDS",
        )
        for key in passthrough_keys:
            value = os.environ.get(key)
            if value:
                env[key] = value

        return env

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("KBenchHarborAgent requires a model name.")

        instance_id = self._resolve_instance_id(context)
        cli_path = f"/installed-agent/{self._cli_path.name}"
        console_log = (
            f"{EnvironmentPaths.agent_dir.as_posix()}/{self._CONSOLE_FILENAME}"
        )

        command = "".join(
            [
                "set -euo pipefail; ",
                f"mkdir -p {shlex.quote(EnvironmentPaths.agent_dir.as_posix())}; ",
                "source /installed-agent/runtime-path.sh; ",
                f"node {shlex.quote(cli_path)} run ",
                f"--benchmark {shlex.quote(self._benchmark)} ",
                f"--harness {shlex.quote(self._harness)} ",
                f"--instruction {shlex.quote(instruction)} ",
                f"--model-name {shlex.quote(self.model_name)} ",
                f"--instance-id {shlex.quote(instance_id)} ",
                '--workdir "$(pwd)" ',
                f"--run-dir {shlex.quote(EnvironmentPaths.agent_dir.as_posix())} ",
                f"2>&1 | tee {shlex.quote(console_log)}",
            ]
        )

        await self.exec_as_agent(
            environment,
            command=f"bash -lc {shlex.quote(command)}",
            env=self._build_container_env(),
        )
