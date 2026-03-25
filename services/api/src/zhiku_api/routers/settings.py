from __future__ import annotations

import json
import os
import sqlite3
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..config import REPO_ROOT as CONFIG_REPO_ROOT
from ..services import AsrRuntimeService

router = APIRouter(prefix="/api/v1", tags=["settings"])

LEGACY_ENV_FILE = Path(__file__).resolve().parents[4] / ".env"
ENV_FILE = CONFIG_REPO_ROOT / ".env"
BILIBILI_BRIDGE_EXTENSION_DIR = CONFIG_REPO_ROOT / "extensions" / "zhiku-bilibili-bridge"
BILIBILI_BRIDGE_INSTALL_DOC = CONFIG_REPO_ROOT / "docs" / "release" / "知库_浏览器小助手安装说明.md"
BILIBILI_BRIDGE_HELPER_SCRIPT = CONFIG_REPO_ROOT / "scripts" / "dev" / "open_bilibili_bridge_helper.ps1"
BILIBILI_BRIDGE_DOCS_DIR = CONFIG_REPO_ROOT / "docs" / "release"


class ModelSettings(BaseModel):
    provider: str = "builtin"
    chat_model: str = "qwen2.5:7b"
    embedding_model: str = "bge-m3"
    llm_api_base_url: str = ""
    llm_api_key_configured: bool = False
    participation_mode: str = "balanced"


class ModelSettingsUpdate(BaseModel):
    provider: str | None = None
    chat_model: str | None = None
    embedding_model: str | None = None
    llm_api_base_url: str | None = None
    llm_api_key: str | None = None
    participation_mode: str | None = None


class AsrSettings(BaseModel):
    selected: bool = False
    available: bool = False
    configured: bool = False
    provider: str = ""
    model: str = ""
    api_base_url: str = ""
    api_key_configured: bool = False
    config_mode: str = "disabled"
    inherited_from_model: bool = False
    local_runtime_ready: bool = False
    local_engine: str = ""
    runtime_summary: str = ""
    summary: str = ""
    recommended_action: str = ""
    faster_whisper_installed: bool = False
    openai_whisper_installed: bool = False
    ffmpeg_available: bool = False


class AsrSettingsUpdate(BaseModel):
    provider: str | None = None
    model: str | None = None
    api_base_url: str | None = None
    api_key: str | None = None


class BilibiliSettings(BaseModel):
    browser_bridge_enabled: bool = True
    browser_bridge_active: bool = False
    browser_bridge_available: bool = False
    browser_bridge_source_label: str = ""
    browser_bridge_summary: str = ""
    browser_bridge_last_seen: str = ""
    browser_bridge_expires_at: str = ""
    browser_bridge_extension_dir: str = ""
    browser_bridge_install_doc: str = ""
    cookie_enabled: bool = False
    cookie_active: bool = False
    cookie_stored: bool = False
    cookie_configured: bool = False
    cookie_source: str = "none"
    cookie_file: str = ""


class BilibiliSettingsUpdate(BaseModel):
    browser_bridge_enabled: bool | None = None
    cookie_enabled: bool | None = None
    cookie_file: str | None = None
    cookie_inline: str | None = None


class SettingsResponse(BaseModel):
    knowledge_base_dir: str
    export_dir: str
    log_dir: str
    model: ModelSettings
    asr: AsrSettings
    bilibili: BilibiliSettings


class SettingsUpdate(BaseModel):
    knowledge_base_dir: str | None = None
    export_dir: str | None = None
    model: ModelSettingsUpdate | None = None
    asr: AsrSettingsUpdate | None = None
    bilibili: BilibiliSettingsUpdate | None = None


class OpenBilibiliBridgeHelperRequest(BaseModel):
    browser: str = "auto"
    dry_run: bool = False


class OpenBilibiliBridgeHelperResponse(BaseModel):
    ok: bool = True
    opened: bool = True
    browser: str = "auto"
    helper_script: str = ""
    extension_dir: str = ""
    docs_dir: str = ""
    message: str = ""


def _build_response(request: Request) -> SettingsResponse:
    container = request.app.state.container
    settings = container.settings
    bridge_status = container.bilibili_session_broker.build_browser_bridge_status()
    asr_status = AsrRuntimeService(settings).build_status_payload()
    return SettingsResponse(
        knowledge_base_dir=str(settings.knowledge_base_dir),
        export_dir=str(settings.knowledge_base_dir / "exports"),
        log_dir=str(settings.log_dir),
        model=ModelSettings(
            provider=settings.model_provider,
            chat_model=settings.chat_model,
            embedding_model=settings.embedding_model,
            llm_api_base_url=settings.llm_api_base_url,
            llm_api_key_configured=bool(settings.llm_api_key.strip()),
            participation_mode=settings.llm_participation_mode_normalized,
        ),
        asr=AsrSettings(**asr_status),
        bilibili=BilibiliSettings(
            browser_bridge_enabled=settings.bilibili_browser_bridge_enabled,
            browser_bridge_active=bridge_status["browser_bridge_active"],
            browser_bridge_available=bridge_status["browser_bridge_available"],
            browser_bridge_source_label=bridge_status["browser_bridge_source_label"],
            browser_bridge_summary=bridge_status["browser_bridge_summary"],
            browser_bridge_last_seen=bridge_status["browser_bridge_last_seen"],
            browser_bridge_expires_at=bridge_status["browser_bridge_expires_at"],
            browser_bridge_extension_dir=str(BILIBILI_BRIDGE_EXTENSION_DIR),
            browser_bridge_install_doc=str(BILIBILI_BRIDGE_INSTALL_DOC),
            cookie_enabled=settings.bilibili_cookie_enabled,
            cookie_active=settings.bilibili_cookie_active,
            cookie_stored=settings.bilibili_cookie_configured,
            cookie_configured=settings.bilibili_cookie_configured,
            cookie_source=settings.bilibili_cookie_source,
            cookie_file=settings.bilibili_cookie_file,
        ),
    )


def _save_ui_snapshot(request: Request, payload: SettingsUpdate) -> None:
    container = request.app.state.container
    db_path = container.settings.db_path
    now = datetime.now(UTC).isoformat()
    current = _build_response(request)
    bridge_status = container.bilibili_session_broker.build_browser_bridge_status()

    merged = {
        "knowledge_base_dir": payload.knowledge_base_dir or current.knowledge_base_dir,
        "export_dir": payload.export_dir or current.export_dir,
        "model": {
            "provider": payload.model.provider if payload.model and payload.model.provider is not None else current.model.provider,
            "chat_model": payload.model.chat_model if payload.model and payload.model.chat_model is not None else current.model.chat_model,
            "embedding_model": payload.model.embedding_model if payload.model and payload.model.embedding_model is not None else current.model.embedding_model,
            "llm_api_base_url": payload.model.llm_api_base_url if payload.model and payload.model.llm_api_base_url is not None else current.model.llm_api_base_url,
            "llm_api_key_configured": bool((payload.model.llm_api_key if payload.model and payload.model.llm_api_key is not None else container.settings.llm_api_key).strip()),
            "participation_mode": payload.model.participation_mode if payload.model and payload.model.participation_mode is not None else current.model.participation_mode,
        },
        "asr": {
            "provider": payload.asr.provider if payload.asr and payload.asr.provider is not None else current.asr.provider,
            "model": payload.asr.model if payload.asr and payload.asr.model is not None else current.asr.model,
            "api_base_url": payload.asr.api_base_url if payload.asr and payload.asr.api_base_url is not None else current.asr.api_base_url,
            "api_key_configured": bool(container.settings.asr_effective_api_key.strip()),
            "config_mode": container.settings.asr_config_mode,
            "inherited_from_model": container.settings.asr_inherited_from_model,
            "selected": current.asr.selected,
            "available": current.asr.available,
            "configured": current.asr.configured,
            "local_runtime_ready": current.asr.local_runtime_ready,
            "local_engine": current.asr.local_engine,
            "runtime_summary": current.asr.runtime_summary,
            "summary": current.asr.summary,
            "recommended_action": current.asr.recommended_action,
        },
        "bilibili": {
            "browser_bridge_enabled": container.settings.bilibili_browser_bridge_enabled,
            "browser_bridge_active": bridge_status["browser_bridge_active"],
            "browser_bridge_available": bridge_status["browser_bridge_available"],
            "browser_bridge_source_label": bridge_status["browser_bridge_source_label"],
            "browser_bridge_summary": bridge_status["browser_bridge_summary"],
            "cookie_enabled": container.settings.bilibili_cookie_enabled,
            "cookie_active": container.settings.bilibili_cookie_active,
            "cookie_stored": container.settings.bilibili_cookie_configured,
            "cookie_configured": container.settings.bilibili_cookie_configured,
            "cookie_source": container.settings.bilibili_cookie_source,
            "cookie_file": container.settings.bilibili_cookie_file,
        },
    }

    connection = sqlite3.connect(db_path)
    try:
        connection.execute(
            """
            INSERT INTO settings (key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at
            """,
            ("ui", json.dumps(merged, ensure_ascii=False), now),
        )
        connection.commit()
    finally:
        connection.close()


def _write_env_file(request: Request) -> None:
    settings = request.app.state.container.settings
    env_values = {
        "ZHIKU_MODEL_PROVIDER": settings.model_provider,
        "ZHIKU_CHAT_MODEL": settings.chat_model,
        "ZHIKU_EMBEDDING_MODEL": settings.embedding_model,
        "ZHIKU_LLM_API_BASE_URL": settings.llm_api_base_url,
        "ZHIKU_LLM_API_KEY": settings.llm_api_key,
        "ZHIKU_LLM_PARTICIPATION_MODE": settings.llm_participation_mode_normalized,
        "ZHIKU_ASR_PROVIDER": settings.asr_provider,
        "ZHIKU_ASR_MODEL": settings.asr_model,
        "ZHIKU_ASR_API_BASE_URL": settings.asr_api_base_url,
        "ZHIKU_ASR_API_KEY": settings.asr_api_key,
        "ZHIKU_BILIBILI_BROWSER_BRIDGE_ENABLED": settings.bilibili_browser_bridge_enabled,
        "ZHIKU_BILIBILI_COOKIE_ENABLED": settings.bilibili_cookie_enabled,
        "ZHIKU_BILIBILI_COOKIE": settings.bilibili_cookie,
        "ZHIKU_BILIBILI_COOKIE_FILE": settings.bilibili_cookie_file,
    }
    lines = [f'{key}="{str(value).replace("\\", "\\\\").replace("\"", "\\\"")}"' for key, value in env_values.items()]
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
    if LEGACY_ENV_FILE != ENV_FILE:
        LEGACY_ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _apply_runtime_settings(request: Request, payload: SettingsUpdate) -> None:
    settings = request.app.state.container.settings
    if payload.model is not None:
        if payload.model.provider is not None:
            settings.model_provider = payload.model.provider.strip() or settings.model_provider
        if payload.model.chat_model is not None:
            settings.chat_model = payload.model.chat_model.strip() or settings.chat_model
        if payload.model.embedding_model is not None:
            settings.embedding_model = payload.model.embedding_model.strip() or settings.embedding_model
        if payload.model.llm_api_base_url is not None:
            settings.llm_api_base_url = payload.model.llm_api_base_url.strip()
        if payload.model.llm_api_key is not None:
            settings.llm_api_key = payload.model.llm_api_key.strip()
        if payload.model.participation_mode is not None:
            settings.llm_participation_mode = payload.model.participation_mode.strip()

    if payload.asr is not None:
        if payload.asr.provider is not None:
            settings.asr_provider = payload.asr.provider.strip()
        if payload.asr.model is not None:
            settings.asr_model = payload.asr.model.strip()
        if payload.asr.api_base_url is not None:
            settings.asr_api_base_url = payload.asr.api_base_url.strip()
        if payload.asr.api_key is not None:
            settings.asr_api_key = payload.asr.api_key.strip()

    if payload.bilibili is not None:
        if payload.bilibili.browser_bridge_enabled is not None:
            settings.bilibili_browser_bridge_enabled = payload.bilibili.browser_bridge_enabled
        if payload.bilibili.cookie_enabled is not None:
            settings.bilibili_cookie_enabled = payload.bilibili.cookie_enabled
        if payload.bilibili.cookie_file is not None:
            settings.bilibili_cookie_file = payload.bilibili.cookie_file.strip()
        if payload.bilibili.cookie_inline is not None:
            settings.bilibili_cookie = payload.bilibili.cookie_inline.strip()


def _launch_detached_process(command: list[str], *, cwd: Path) -> None:
    creationflags = 0
    if os.name == "nt":
        creationflags = (
            getattr(subprocess, "DETACHED_PROCESS", 0)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        )

    subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def _open_bilibili_bridge_helper(*, browser: str = "auto", dry_run: bool = False) -> OpenBilibiliBridgeHelperResponse:
    normalized_browser = (browser or "auto").strip().lower() or "auto"
    if normalized_browser not in {"auto", "edge", "chrome"}:
        raise ValueError("browser 仅支持 auto / edge / chrome")

    if not BILIBILI_BRIDGE_HELPER_SCRIPT.exists():
        raise FileNotFoundError(f"未找到辅助安装脚本：{BILIBILI_BRIDGE_HELPER_SCRIPT}")

    if not BILIBILI_BRIDGE_EXTENSION_DIR.exists():
        raise FileNotFoundError(f"未找到浏览器小助手目录：{BILIBILI_BRIDGE_EXTENSION_DIR}")

    if dry_run:
        return OpenBilibiliBridgeHelperResponse(
            opened=False,
            browser=normalized_browser,
            helper_script=str(BILIBILI_BRIDGE_HELPER_SCRIPT),
            extension_dir=str(BILIBILI_BRIDGE_EXTENSION_DIR),
            docs_dir=str(BILIBILI_BRIDGE_DOCS_DIR),
            message="辅助安装入口可用。",
        )

    _launch_detached_process(
        [
            "powershell.exe",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(BILIBILI_BRIDGE_HELPER_SCRIPT),
            "-Browser",
            normalized_browser,
        ],
        cwd=CONFIG_REPO_ROOT,
    )
    return OpenBilibiliBridgeHelperResponse(
        opened=True,
        browser=normalized_browser,
        helper_script=str(BILIBILI_BRIDGE_HELPER_SCRIPT),
        extension_dir=str(BILIBILI_BRIDGE_EXTENSION_DIR),
        docs_dir=str(BILIBILI_BRIDGE_DOCS_DIR),
        message="已为你打开浏览器扩展页和小助手目录。",
    )


@router.get("/settings", response_model=SettingsResponse)
def get_settings(request: Request) -> SettingsResponse:
    return _build_response(request)


@router.put("/settings", response_model=SettingsResponse)
def update_settings(payload: SettingsUpdate, request: Request) -> SettingsResponse:
    _apply_runtime_settings(request, payload)
    _save_ui_snapshot(request, payload)
    _write_env_file(request)
    from ..config import get_settings
    get_settings.cache_clear()
    return _build_response(request)


@router.post("/settings/bilibili/helper/open", response_model=OpenBilibiliBridgeHelperResponse)
def open_bilibili_bridge_helper(
    payload: OpenBilibiliBridgeHelperRequest | None = None,
) -> OpenBilibiliBridgeHelperResponse:
    request_payload = payload or OpenBilibiliBridgeHelperRequest()
    try:
        return _open_bilibili_bridge_helper(
            browser=request_payload.browser,
            dry_run=request_payload.dry_run,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"打开浏览器小助手失败：{exc}") from exc


