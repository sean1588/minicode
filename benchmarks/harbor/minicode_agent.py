"""Harbor installed-agent adapter for minicode.

Usage:
    harbor run \
        --path /path/to/harbor/task \
        --agent-import-path benchmarks.harbor.minicode_agent:MinicodeAgent \
        --model openai/gpt-5

The adapter intentionally shells out to ``minicode benchmark run`` instead of
embedding product internals. That keeps Harbor integration in the benchmark
layer and preserves the normal minicode runtime surface.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


DEFAULT_PACKAGE_SPEC = "@sean.holung/minicode"
DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
RESULT_PATH = "/logs/agent/minicode-result.json"
PATCH_PATH = "/logs/agent/minicode.patch"
STDOUT_PATH = "/logs/agent/minicode.stdout"


class MinicodeAgent(BaseInstalledAgent):
    """Run minicode as a Harbor installed agent."""

    @staticmethod
    def name() -> str:
        return "minicode"

    def __init__(
        self,
        *args: Any,
        provider: str | None = None,
        base_url: str | None = None,
        package_spec: str | None = None,
        install_command: str | None = None,
        max_steps: int | None = None,
        max_context_tokens: int | None = None,
        command_timeout_ms: int | None = None,
        model_timeout_seconds: int | None = None,
        max_tool_output_chars: int | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._provider = provider or os.environ.get("MINICODE_HARBOR_PROVIDER")
        self._base_url = base_url or os.environ.get("MINICODE_HARBOR_BASE_URL")
        self._package_spec = (
            package_spec
            or os.environ.get("MINICODE_HARBOR_PACKAGE_SPEC")
            or DEFAULT_PACKAGE_SPEC
        )
        self._install_command = install_command or os.environ.get(
            "MINICODE_HARBOR_INSTALL_COMMAND"
        )
        self._benchmark_settings = {
            "MAX_STEPS": max_steps,
            "MAX_CONTEXT_TOKENS": max_context_tokens,
            "COMMAND_TIMEOUT_MS": command_timeout_ms,
            "MODEL_TIMEOUT_SECONDS": model_timeout_seconds,
            "MAX_TOOL_OUTPUT_CHARS": max_tool_output_chars,
        }

    def version(self) -> str | None:
        return self._version

    def get_version_command(self) -> str | None:
        return "minicode --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if self._install_command:
            await self.exec_as_root(environment, command=self._install_command)
            return

        await self.exec_as_root(
            environment,
            command=(
                "apt-get update && "
                "apt-get install -y curl ca-certificates git build-essential python3"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_root(
            environment,
            command=(
                "if ! command -v node >/dev/null 2>&1 || "
                "! node -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\" || "
                "! command -v npm >/dev/null 2>&1; "
                "then "
                "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && "
                "apt-get install -y nodejs; "
                "fi"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_root(
            environment,
            command=f"npm install -g {shlex.quote(self._package_spec)}",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        result_file = self.logs_dir / "minicode-result.json"
        if not result_file.exists():
            return

        try:
            payload = json.loads(result_file.read_text())
        except (OSError, json.JSONDecodeError):
            return

        usage = payload.get("usage")
        if isinstance(usage, dict):
            context.n_input_tokens = _coerce_int(
                usage.get("inputTokens")
                or usage.get("promptTokens")
                or usage.get("input_tokens")
            )
            context.n_output_tokens = _coerce_int(
                usage.get("outputTokens")
                or usage.get("completionTokens")
                or usage.get("output_tokens")
            )
            context.n_cache_tokens = _coerce_int(
                usage.get("cacheTokens")
                or usage.get("cachedTokens")
                or usage.get("cache_tokens")
            )

        metadata: dict[str, Any] = {
            "provider": payload.get("provider"),
            "model": payload.get("model"),
            "openAiBaseUrl": payload.get("openAiBaseUrl"),
            "durationMs": payload.get("durationMs"),
            "changedFiles": payload.get("changedFiles"),
            "toolUsage": payload.get("toolUsage"),
            "diffOut": payload.get("diffOut"),
        }
        context.metadata = {
            key: value for key, value in metadata.items() if value is not None
        }

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider, base_url = self._resolve_provider()
        env = self._build_env()

        args = [
            "minicode",
            "benchmark",
            "run",
            "--workspace-root",
            ".",
            "--provider",
            provider,
            "--out",
            RESULT_PATH,
            "--diff-out",
            PATCH_PATH,
        ]

        if base_url:
            args.extend(["--base-url", base_url])
        if self.model_name:
            args.extend(["--model", self.model_name])

        config_path = os.environ.get("MINICODE_BENCHMARK_CONFIG")
        if config_path:
            args.extend(["--config", config_path])

        env_file = os.environ.get("MINICODE_BENCHMARK_ENV_FILE")
        if env_file:
            args.extend(["--env-file", env_file])

        args.append(instruction)
        command = " ".join(shlex.quote(arg) for arg in args)
        await self.exec_as_agent(
            environment,
            command=f"set -o pipefail; {command} 2>&1 | tee {STDOUT_PATH}",
            env=env,
        )

        local_result = self.logs_dir / "minicode-result.json"
        await environment.download_file(RESULT_PATH, local_result)

    def _resolve_provider(self) -> tuple[str, str | None]:
        if self._provider:
            normalized = self._provider.strip().lower()
            if normalized == "anthropic":
                return "anthropic", None
            if normalized == "openai":
                return "openai-compatible", self._base_url or DEFAULT_OPENAI_BASE_URL
            if normalized == "openrouter":
                return "openai-compatible", self._base_url or DEFAULT_OPENROUTER_BASE_URL
            if normalized == "openai-compatible":
                return "openai-compatible", self._base_url
            raise ValueError(
                f"Unsupported minicode provider {self._provider!r}; "
                "use openrouter, openai, openai-compatible, or anthropic."
            )

        model_name = self.model_name or ""
        if model_name.startswith("anthropic/") and self._has_env("ANTHROPIC_API_KEY"):
            return "anthropic", None

        if (
            model_name.startswith("openai/")
            and self._has_env("OPENAI_API_KEY")
            and not self._has_env("OPENROUTER_API_KEY")
        ):
            return "openai-compatible", self._base_url or DEFAULT_OPENAI_BASE_URL

        return "openai-compatible", self._base_url or DEFAULT_OPENROUTER_BASE_URL

    def _build_env(self) -> dict[str, str]:
        env: dict[str, str] = {"CONFIRM_DESTRUCTIVE": "false"}
        for key in [
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_BASE_URL",
            "ANTHROPIC_BASE_URL",
            "REASONING_EFFORT",
            "ENABLE_DYNAMIC_PROMPT",
            "KEEP_RECENT_MESSAGES",
            "LOOP_DETECTION_WINDOW",
        ]:
            value = self._get_env(key)
            if value:
                env[key] = value

        for key, value in self._benchmark_settings.items():
            if value is not None:
                env[key] = str(value)

        for source_key, target_key in [
            ("MINICODE_BENCHMARK_MAX_STEPS", "MAX_STEPS"),
            ("MINICODE_BENCHMARK_MAX_CONTEXT_TOKENS", "MAX_CONTEXT_TOKENS"),
            ("MINICODE_BENCHMARK_COMMAND_TIMEOUT_MS", "COMMAND_TIMEOUT_MS"),
            ("MINICODE_BENCHMARK_MODEL_TIMEOUT_SECONDS", "MODEL_TIMEOUT_SECONDS"),
            ("MINICODE_BENCHMARK_MAX_TOOL_OUTPUT_CHARS", "MAX_TOOL_OUTPUT_CHARS"),
            ("MINICODE_BENCHMARK_REASONING_EFFORT", "REASONING_EFFORT"),
            ("MINICODE_BENCHMARK_ENABLE_DYNAMIC_PROMPT", "ENABLE_DYNAMIC_PROMPT"),
            ("MINICODE_BENCHMARK_KEEP_RECENT_MESSAGES", "KEEP_RECENT_MESSAGES"),
            ("MINICODE_BENCHMARK_LOOP_DETECTION_WINDOW", "LOOP_DETECTION_WINDOW"),
        ]:
            value = self._get_env(source_key)
            if value:
                env[target_key] = value

        return env


def _coerce_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
