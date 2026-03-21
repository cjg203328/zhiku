from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field


router = APIRouter(prefix="/api/v1/bilibili/bridge", tags=["bilibili-bridge"])


class BrowserBridgeSessionRequest(BaseModel):
    cookie_header: str = Field(min_length=1)
    source_label: str = "浏览器小助手"
    browser_name: str = ""
    profile_name: str = ""
    ttl_seconds: int = 900
    reason: str = ""


@router.post("/session")
def publish_browser_bridge_session(payload: BrowserBridgeSessionRequest, request: Request) -> dict:
    broker = request.app.state.container.bilibili_session_broker
    try:
        session = broker.publish_browser_session(
            cookie_header=payload.cookie_header,
            source_label=payload.source_label,
            browser_name=payload.browser_name,
            profile_name=payload.profile_name,
            ttl_seconds=payload.ttl_seconds,
            reason=payload.reason,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "ok": True,
        "source_label": session.source_label,
        "received_at": session.received_at.isoformat(),
        "expires_at": session.expires_at.isoformat(),
        "summary": broker.build_browser_bridge_status()["browser_bridge_summary"],
    }


@router.get("/status")
def get_browser_bridge_status(request: Request) -> dict:
    broker = request.app.state.container.bilibili_session_broker
    return {
        "ok": True,
        **broker.build_browser_bridge_status(),
    }


@router.delete("/session")
def clear_browser_bridge_session(request: Request) -> dict:
    broker = request.app.state.container.bilibili_session_broker
    broker.clear_browser_session()
    return {
        "ok": True,
        **broker.build_browser_bridge_status(),
    }
