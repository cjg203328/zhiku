from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import BilibiliParseError, DiagnosticsService

router = APIRouter(prefix="/api/v1/diagnostics", tags=["diagnostics"])


class BilibiliProbeRequest(BaseModel):
    url: str = Field(min_length=1)


class ModelProbeRequest(BaseModel):
    provider: str = "openai_compatible"
    chat_model: str = Field(min_length=1)
    api_base_url: str = Field(min_length=1)
    api_key: str | None = None


@router.get("/summary")
def get_diagnostics_summary(request: Request) -> dict:
    container = request.app.state.container
    return DiagnosticsService(
        container.settings,
        bilibili_session_broker=container.bilibili_session_broker,
    ).build_summary()


@router.post("/export")
def export_diagnostics(request: Request) -> dict:
    container = request.app.state.container
    archive_path = DiagnosticsService(
        container.settings,
        bilibili_session_broker=container.bilibili_session_broker,
    ).export_bundle()
    return {
        "ok": True,
        "path": str(archive_path),
    }


@router.post("/bilibili-probe")
def probe_bilibili_url(payload: BilibiliProbeRequest, request: Request) -> dict:
    container = request.app.state.container
    try:
        probe = DiagnosticsService(
            container.settings,
            bilibili_session_broker=container.bilibili_session_broker,
        ).probe_bilibili_url(payload.url)
    except BilibiliParseError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "probe": probe,
    }


@router.post("/model-probe")
def probe_model_connection(payload: ModelProbeRequest, request: Request) -> dict:
    container = request.app.state.container
    probe = DiagnosticsService(
        container.settings,
        bilibili_session_broker=container.bilibili_session_broker,
    ).probe_model_connection(
        provider=payload.provider,
        chat_model=payload.chat_model,
        api_base_url=payload.api_base_url,
        api_key=payload.api_key,
    )
    if not probe.get("ok"):
        raise HTTPException(status_code=400, detail=probe.get("message") or "模型接口当前不可用")
    return {
        "ok": True,
        "probe": probe,
    }
