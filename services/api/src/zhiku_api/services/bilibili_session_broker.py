from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import Lock
from typing import Any

from ..config import AppSettings


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _normalize_cookie_header(value: str) -> str:
    parts = [item.strip() for item in value.split(";") if item.strip()]
    return "; ".join(parts)


@dataclass(slots=True)
class BrowserBridgeSession:
    cookie_header: str
    source_label: str
    browser_name: str
    profile_name: str
    received_at: datetime
    expires_at: datetime
    reason: str = ""

    @property
    def is_active(self) -> bool:
        return bool(self.cookie_header.strip()) and self.expires_at > _utcnow()


@dataclass(slots=True)
class BilibiliAuthState:
    cookie_header: str
    mode: str
    source: str
    source_label: str
    enabled: bool
    active: bool
    stored: bool
    browser_bridge_enabled: bool
    browser_bridge_active: bool
    browser_bridge_source_label: str


class BilibiliSessionBroker:
    """协调 B 站登录态来源。

    第一版优先支持浏览器小助手上报的临时会话，并保留手动 Cookie 作为高级兜底。
    浏览器会话只保存在内存里，默认不写盘。
    """

    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self._lock = Lock()
        self._browser_session: BrowserBridgeSession | None = None

    def publish_browser_session(
        self,
        *,
        cookie_header: str,
        source_label: str,
        browser_name: str = "",
        profile_name: str = "",
        ttl_seconds: int = 900,
        reason: str = "",
    ) -> BrowserBridgeSession:
        normalized_cookie = _normalize_cookie_header(cookie_header)
        if not normalized_cookie:
            raise ValueError("浏览器登录状态为空")

        ttl = max(60, min(int(ttl_seconds or 900), 12 * 60 * 60))
        now = _utcnow()
        session = BrowserBridgeSession(
            cookie_header=normalized_cookie,
            source_label=source_label.strip() or "浏览器小助手",
            browser_name=browser_name.strip(),
            profile_name=profile_name.strip(),
            received_at=now,
            expires_at=now + timedelta(seconds=ttl),
            reason=reason.strip(),
        )
        with self._lock:
            self._browser_session = session
        return session

    def clear_browser_session(self) -> None:
        with self._lock:
            self._browser_session = None

    def _get_browser_session(self) -> BrowserBridgeSession | None:
        with self._lock:
            session = self._browser_session
            if session is None:
                return None
            if not session.is_active:
                self._browser_session = None
                return None
            return session

    def build_browser_bridge_status(self) -> dict[str, Any]:
        session = self._get_browser_session()
        enabled = bool(self.settings.bilibili_browser_bridge_enabled)
        if session is not None:
            summary = f"已连接 {session.source_label}，会自动补需要登录的视频。"
        elif enabled:
            summary = "已打开自动连接，等待浏览器小助手同步当前登录状态。"
        else:
            summary = "当前未打开自动连接，只会读取公开可见内容。"

        return {
            "browser_bridge_enabled": enabled,
            "browser_bridge_active": session is not None,
            "browser_bridge_available": session is not None,
            "browser_bridge_source_label": session.source_label if session is not None else "",
            "browser_bridge_browser_name": session.browser_name if session is not None else "",
            "browser_bridge_profile_name": session.profile_name if session is not None else "",
            "browser_bridge_last_seen": session.received_at.isoformat() if session is not None else "",
            "browser_bridge_expires_at": session.expires_at.isoformat() if session is not None else "",
            "browser_bridge_summary": summary,
        }

    def resolve_auth_state(self) -> BilibiliAuthState:
        browser_status = self.build_browser_bridge_status()
        browser_session = self._get_browser_session()
        manual_cookie = self.settings.bilibili_cookie_stored_value
        manual_configured = bool(manual_cookie)
        manual_enabled = bool(self.settings.bilibili_cookie_enabled)

        if self.settings.bilibili_browser_bridge_enabled and browser_session is not None:
            return BilibiliAuthState(
                cookie_header=browser_session.cookie_header,
                mode="browser_bridge",
                source="browser_bridge",
                source_label=browser_session.source_label,
                enabled=True,
                active=True,
                stored=True,
                browser_bridge_enabled=True,
                browser_bridge_active=True,
                browser_bridge_source_label=browser_session.source_label,
            )

        if manual_enabled and manual_configured:
            return BilibiliAuthState(
                cookie_header=manual_cookie,
                mode="manual_cookie",
                source=self.settings.bilibili_cookie_source,
                source_label="手动提供的登录状态",
                enabled=True,
                active=True,
                stored=True,
                browser_bridge_enabled=bool(browser_status["browser_bridge_enabled"]),
                browser_bridge_active=bool(browser_status["browser_bridge_active"]),
                browser_bridge_source_label=str(browser_status["browser_bridge_source_label"]),
            )

        return BilibiliAuthState(
            cookie_header="",
            mode="public",
            source="none",
            source_label="公开可见内容",
            enabled=bool(self.settings.bilibili_browser_bridge_enabled or self.settings.bilibili_cookie_enabled),
            active=False,
            stored=manual_configured or bool(browser_status["browser_bridge_available"]),
            browser_bridge_enabled=bool(browser_status["browser_bridge_enabled"]),
            browser_bridge_active=bool(browser_status["browser_bridge_active"]),
            browser_bridge_source_label=str(browser_status["browser_bridge_source_label"]),
        )
