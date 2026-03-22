from __future__ import annotations

import os
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_INHERITED_ASR_MODEL = "whisper-1"
DEFAULT_LOCAL_ASR_MODEL = "small"
LOCAL_ASR_PROVIDER = "local_whisper"
SHARED_ASR_HOST_ALLOWLIST = (
    "open.bigmodel.cn",
    "api.openai.com",
)


def _candidate_directories(*candidates: Path | None) -> list[Path]:
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        if candidate is None:
            continue
        path = Path(candidate)
        normalized = str(path)
        if normalized in seen:
            continue
        seen.add(normalized)
        unique.append(path)
    return unique


def _is_writable_directory(path: Path) -> bool:
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / f".zhiku-write-test-{uuid.uuid4().hex}"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def _resolve_first_writable(candidates: list[Path], fallback_leaf: str) -> Path:
    for candidate in candidates:
        if _is_writable_directory(candidate):
            return candidate

    fallback = Path(tempfile.gettempdir()) / "Zhiku" / fallback_leaf
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _default_app_data_dir() -> Path:
    local_app_data = os.getenv("LOCALAPPDATA")
    return _resolve_first_writable(
        _candidate_directories(
            Path(local_app_data) / "Zhiku" / "app" if local_app_data else None,
            Path.home() / "AppData" / "Local" / "Zhiku" / "app",
            Path.home() / ".zhiku" / "app",
        ),
        "app",
    )


def _default_knowledge_base_dir() -> Path:
    user_profile = os.getenv("USERPROFILE")
    local_app_data = os.getenv("LOCALAPPDATA")
    return _resolve_first_writable(
        _candidate_directories(
            Path(user_profile) / "Documents" / "ZhikuLibrary" if user_profile else None,
            Path.home() / "Documents" / "ZhikuLibrary",
            Path(local_app_data) / "Zhiku" / "library" if local_app_data else None,
            Path.home() / ".zhiku" / "library",
        ),
        "library",
    )


class AppSettings(BaseSettings):
    app_name: str = "zhiku-api"
    app_version: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int = 38765
    app_data_dir: Path = Field(default_factory=_default_app_data_dir)
    knowledge_base_dir: Path = Field(default_factory=_default_knowledge_base_dir)

    model_provider: str = "builtin"
    chat_model: str = "qwen2.5:7b"
    embedding_model: str = "bge-m3"
    llm_api_base_url: str = ""
    llm_api_key: str = ""
    llm_timeout_seconds: float = 45.0

    asr_provider: str = ""
    asr_model: str = ""
    asr_api_base_url: str = ""
    asr_api_key: str = ""

    bilibili_browser_bridge_enabled: bool = True
    bilibili_cookie_enabled: bool = False
    bilibili_cookie: str = ""
    bilibili_cookie_file: str = ""

    ocr_enabled: bool = False

    model_config = SettingsConfigDict(
        env_prefix="ZHIKU_",
        env_file=REPO_ROOT / ".env",
        extra="ignore",
    )

    def model_post_init(self, __context: object) -> None:
        self.app_data_dir = _resolve_first_writable(
            _candidate_directories(
                self.app_data_dir,
                _default_app_data_dir(),
                Path.home() / ".zhiku" / "app",
            ),
            "app",
        )
        self.knowledge_base_dir = _resolve_first_writable(
            _candidate_directories(
                self.knowledge_base_dir,
                Path.home() / "Documents" / "ZhikuLibrary",
                self.app_data_dir.parent / "library",
                Path.home() / ".zhiku" / "library",
            ),
            "library",
        )

    @property
    def log_dir(self) -> Path:
        return self.app_data_dir / "logs"

    @property
    def runtime_dir(self) -> Path:
        return self.app_data_dir / "runtime"

    @property
    def diagnostics_dir(self) -> Path:
        return self.app_data_dir / "diagnostics"

    @property
    def db_path(self) -> Path:
        return self.knowledge_base_dir / "db" / "zhiku.db"

    @property
    def faiss_index_path(self) -> Path:
        return self.knowledge_base_dir / "index" / "faiss.index"

    @property
    def llm_enabled(self) -> bool:
        return (
            self.model_provider == "openai_compatible"
            and bool(self.llm_api_base_url.strip())
            and bool(self.llm_api_key.strip())
            and bool(self.chat_model.strip())
        )

    @property
    def llm_shared_asr_supported(self) -> bool:
        if not self.llm_enabled:
            return False
        candidate = self.llm_api_base_url.strip().lower()
        parsed = urlparse(candidate)
        host = parsed.netloc.lower() if parsed.netloc else candidate
        return any(item in host for item in SHARED_ASR_HOST_ALLOWLIST)

    @property
    def asr_effective_provider(self) -> str:
        provider = self.asr_provider.strip()
        if provider.lower() in {"disabled", "off", "none"}:
            return ""
        if provider:
            return provider
        if self.asr_model.strip() and self.llm_enabled:
            return "openai_compatible"
        if self.llm_shared_asr_supported:
            return "openai_compatible"
        return LOCAL_ASR_PROVIDER

    @property
    def asr_effective_model(self) -> str:
        model = self.asr_model.strip()
        if model:
            return model
        if self.asr_effective_provider == LOCAL_ASR_PROVIDER:
            return DEFAULT_LOCAL_ASR_MODEL
        if self.asr_effective_provider == "openai_compatible":
            return DEFAULT_INHERITED_ASR_MODEL
        return ""

    @property
    def asr_effective_api_base_url(self) -> str:
        if self.asr_effective_provider == LOCAL_ASR_PROVIDER:
            return ""
        base_url = self.asr_api_base_url.strip()
        if base_url:
            return base_url
        if self.asr_effective_provider == "openai_compatible":
            return self.llm_api_base_url.strip()
        return ""

    @property
    def asr_effective_api_key(self) -> str:
        if self.asr_effective_provider == LOCAL_ASR_PROVIDER:
            return ""
        api_key = self.asr_api_key.strip()
        if api_key:
            return api_key
        if self.asr_effective_provider == "openai_compatible":
            return self.llm_api_key.strip()
        return ""

    @property
    def asr_config_mode(self) -> str:
        provider = self.asr_provider.strip()
        if provider.lower() in {"disabled", "off", "none"}:
            return "disabled"
        if provider == LOCAL_ASR_PROVIDER:
            return "local"

        explicit_fields = [
            provider,
            self.asr_model.strip(),
            self.asr_api_base_url.strip(),
            self.asr_api_key.strip(),
        ]
        explicit_count = sum(1 for value in explicit_fields if value)
        if explicit_count == 0:
            if self.llm_shared_asr_supported:
                return "inherited"
            return "auto_local"
        if explicit_count == 4:
            return "explicit"
        if self.asr_effectively_enabled:
            return "hybrid"
        return "disabled"

    @property
    def asr_inherited_from_model(self) -> bool:
        return self.asr_config_mode in {"inherited", "hybrid"}

    @property
    def asr_effectively_enabled(self) -> bool:
        if self.asr_effective_provider == LOCAL_ASR_PROVIDER:
            return bool(self.asr_effective_model)
        return bool(
            self.asr_effective_provider
            and self.asr_effective_api_base_url
            and self.asr_effective_api_key
            and self.asr_effective_model
        )

    @property
    def bilibili_cookie_stored_value(self) -> str:
        inline_cookie = self.bilibili_cookie.strip()
        if inline_cookie:
            return inline_cookie

        cookie_file = self.bilibili_cookie_file.strip()
        if not cookie_file:
            return ""

        try:
            path = Path(cookie_file)
            if path.exists() and path.is_file():
                return path.read_text(encoding="utf-8", errors="ignore").strip()
        except OSError:
            return ""
        return ""

    @property
    def bilibili_cookie_configured(self) -> bool:
        return bool(self.bilibili_cookie_stored_value)

    @property
    def bilibili_cookie_active(self) -> bool:
        return self.bilibili_cookie_enabled and bool(self.bilibili_cookie_stored_value)

    @property
    def bilibili_cookie_value(self) -> str:
        if not self.bilibili_cookie_enabled:
            return ""
        return self.bilibili_cookie_stored_value

    @property
    def bilibili_cookie_source(self) -> str:
        if self.bilibili_cookie.strip():
            return "env"
        if self.bilibili_cookie_file.strip():
            return "file"
        return "none"


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    return AppSettings()
