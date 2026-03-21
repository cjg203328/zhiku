from __future__ import annotations

from datetime import datetime, UTC
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any
from zipfile import ZIP_DEFLATED, ZipFile

from .asr_runtime_service import AsrRuntimeService
from .bilibili_service import BilibiliService
from .llm_gateway import LlmGateway
from .model_status_service import ModelStatusService

if TYPE_CHECKING:
    from ..config import AppSettings
    from .bilibili_session_broker import BilibiliSessionBroker


class DiagnosticsService:
    def __init__(
        self,
        settings: "AppSettings" | Any,
        *,
        bilibili_session_broker: "BilibiliSessionBroker | None" = None,
    ) -> None:
        self.settings = settings
        self.bilibili_session_broker = bilibili_session_broker

    def probe_bilibili_url(self, raw_url: str) -> dict[str, Any]:
        return BilibiliService(
            settings=self.settings,
            bilibili_session_broker=self.bilibili_session_broker,
        ).probe(raw_url)

    def probe_model_connection(
        self,
        *,
        provider: str | None = None,
        chat_model: str | None = None,
        api_base_url: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        test_settings = self.settings.model_copy(deep=True)
        if provider is not None:
            test_settings.model_provider = provider.strip() or test_settings.model_provider
        if chat_model is not None:
            test_settings.chat_model = chat_model.strip()
        if api_base_url is not None:
            test_settings.llm_api_base_url = api_base_url.strip()
        if api_key is not None:
            test_settings.llm_api_key = api_key.strip()
        return LlmGateway(test_settings).probe_connection()

    def list_remote_models(
        self,
        *,
        provider: str | None = None,
        api_base_url: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        test_settings = self.settings.model_copy(deep=True)
        if provider is not None:
            test_settings.model_provider = provider.strip() or test_settings.model_provider
        if api_base_url is not None:
            test_settings.llm_api_base_url = api_base_url.strip()
        if api_key is not None:
            test_settings.llm_api_key = api_key.strip()
        return LlmGateway(test_settings).list_models()

    def export_bundle(self) -> Path:
        self.settings.diagnostics_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
        summary_path = self.settings.diagnostics_dir / f"diagnostics-summary-{timestamp}.json"
        archive_path = self.settings.diagnostics_dir / f"diagnostics-{timestamp}.zip"

        summary = self.build_summary()
        summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
            archive.write(summary_path, arcname=summary_path.name)
            self._add_dir(archive, self.settings.log_dir, prefix="logs")
            self._add_dir(archive, self.settings.runtime_dir, prefix="runtime")

        return archive_path

    def build_summary(self) -> dict:
        model_status = ModelStatusService(
            provider=self.settings.model_provider,
            chat_model=self.settings.chat_model,
            embedding_model=self.settings.embedding_model,
            llm_api_base_url=self.settings.llm_api_base_url,
            llm_api_key=self.settings.llm_api_key,
            ocr_enabled=self.settings.ocr_enabled,
        ).collect()
        asr_status = AsrRuntimeService(self.settings).build_status_payload()

        return {
            "generated_at": datetime.now(UTC).isoformat(),
            "app": {
                "name": self.settings.app_name,
                "version": self.settings.app_version,
            },
            "paths": {
                "app_data_dir": str(self.settings.app_data_dir),
                "knowledge_base_dir": str(self.settings.knowledge_base_dir),
                "log_dir": str(self.settings.log_dir),
                "runtime_dir": str(self.settings.runtime_dir),
                "diagnostics_dir": str(self.settings.diagnostics_dir),
                "db_path": str(self.settings.db_path),
            },
            "filesystem": {
                "knowledge_base_exists": self.settings.knowledge_base_dir.exists(),
                "db_exists": self.settings.db_path.exists(),
                "log_dir_exists": self.settings.log_dir.exists(),
            },
            "models": {
                "provider": model_status.provider,
                "provider_ready": model_status.provider_ready,
                "ollama_available": model_status.ollama_available,
                "ollama_version": model_status.ollama_version,
                "chat_model": self.settings.chat_model,
                "chat_model_ready": model_status.chat_model_ready,
                "embedding_model": self.settings.embedding_model,
                "embedding_ready": model_status.embedding_ready,
                "ocr_ready": model_status.ocr_ready,
                "installed_models": model_status.installed_models,
            },
            "asr": asr_status,
        }

    def _add_dir(self, archive: ZipFile, root: Path, *, prefix: str) -> None:
        if not root.exists():
            return
        for path in root.rglob("*"):
            if path.is_file():
                archive.write(path, arcname=str(Path(prefix) / path.relative_to(root)))
