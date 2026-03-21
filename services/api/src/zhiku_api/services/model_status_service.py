from __future__ import annotations

from dataclasses import dataclass
import subprocess
from shutil import which


@dataclass
class ModelStatus:
    provider: str
    provider_ready: bool
    ollama_available: bool
    ollama_version: str | None
    chat_model_ready: bool
    embedding_ready: bool
    ocr_ready: bool
    installed_models: list[str]


class ModelStatusService:
    def __init__(
        self,
        *,
        provider: str,
        chat_model: str,
        embedding_model: str,
        llm_api_base_url: str,
        llm_api_key: str,
        ocr_enabled: bool,
    ) -> None:
        self.provider = provider
        self.chat_model = chat_model
        self.embedding_model = embedding_model
        self.llm_api_base_url = llm_api_base_url
        self.llm_api_key = llm_api_key
        self.ocr_enabled = ocr_enabled

    def collect(self) -> ModelStatus:
        ollama_path = which("ollama")
        ollama_version = self._run_command(["ollama", "--version"]) if ollama_path else None
        model_output = self._run_command(["ollama", "list"]) if ollama_path else None
        installed_models = self._parse_model_list(model_output)

        if self.provider == "openai_compatible":
            provider_ready = bool(self.llm_api_base_url.strip()) and bool(self.llm_api_key.strip()) and bool(self.chat_model.strip())
            return ModelStatus(
                provider=self.provider,
                provider_ready=provider_ready,
                ollama_available=bool(ollama_path),
                ollama_version=ollama_version,
                chat_model_ready=provider_ready,
                embedding_ready=bool(self.embedding_model.strip()),
                ocr_ready=self.ocr_enabled,
                installed_models=[self.chat_model] if provider_ready else [],
            )

        return ModelStatus(
            provider=self.provider,
            provider_ready=bool(ollama_path),
            ollama_available=bool(ollama_path),
            ollama_version=ollama_version,
            chat_model_ready=self.chat_model in installed_models,
            embedding_ready=self.embedding_model in installed_models,
            ocr_ready=self.ocr_enabled,
            installed_models=installed_models,
        )

    def _run_command(self, command: list[str]) -> str | None:
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=6,
                check=False,
            )
        except Exception:
            return None

        output = (result.stdout or result.stderr or "").strip()
        return output or None

    def _parse_model_list(self, output: str | None) -> list[str]:
        if not output:
            return []

        models: list[str] = []
        for line in output.splitlines():
            stripped = line.strip()
            if not stripped or stripped.lower().startswith("name"):
                continue
            first_column = stripped.split()[0]
            if first_column and first_column not in models:
                models.append(first_column)
        return models
