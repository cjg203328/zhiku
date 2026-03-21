from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
from html import unescape
import json
import re
from typing import Any, Callable

from ..config import AppSettings
from .asr_gateway import AsrGateway
from .asr_runtime_service import AsrRuntimeService
from .bilibili_client import BilibiliHttpClient, BilibiliParseError as _BilibiliParseError
from .bilibili_session_broker import BilibiliAuthState, BilibiliSessionBroker
from .content_link_service import build_seek_url
from .llm_gateway import LlmGateway
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen


BVID_PATTERN = re.compile(r"(BV[0-9A-Za-z]+)", re.IGNORECASE)
URL_PATTERN = re.compile(r"https?://[^\s]+", re.IGNORECASE)
BILIBILI_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)


class BilibiliParseError(RuntimeError):
    pass


@dataclass
class BilibiliVideo:
    bvid: str
    cid: int
    title: str
    author: str | None
    description: str
    cover: str | None
    duration: int | None
    view: int | None
    like: int | None
    pubdate: int | None
    tag_name: str | None


@dataclass
class TranscriptSegment:
    start_ms: int | None
    end_ms: int | None
    text: str
    source_kind: str
    quality_level: str


@dataclass
class SubtitleFetchResult:
    segments: list[TranscriptSegment]
    subtitle_count: int
    need_login: bool
    preview_toast: str | None


class BilibiliService:
    def __init__(
        self,
        *,
        timeout_seconds: float = 12.0,
        json_fetcher: Callable[[str], dict[str, Any]] | None = None,
        text_fetcher: Callable[[str], str] | None = None,
        url_resolver: Callable[[str], str] | None = None,
        settings: AppSettings | None = None,
        bilibili_session_broker: BilibiliSessionBroker | None = None,
    ) -> None:
        self.timeout_seconds = timeout_seconds
        self.settings = settings
        self.bilibili_session_broker = bilibili_session_broker
        self.llm_gateway = LlmGateway(settings) if settings is not None else None
        self.asr_gateway = AsrGateway(settings) if settings is not None else None
        # HTTP 客户端层：可被注入替换，也可直接 mock BilibiliHttpClient
        cookie = settings.bilibili_cookie_value if settings is not None else None
        self._http = BilibiliHttpClient(timeout_seconds=timeout_seconds, cookie=cookie)
        self._json_fetcher = json_fetcher or self._http.fetch_json
        self._text_fetcher = text_fetcher or self._http.fetch_text
        self._url_resolver = url_resolver or self._http.resolve_url

    def _resolve_auth_state(self) -> BilibiliAuthState:
        if self.bilibili_session_broker is not None:
            state = self.bilibili_session_broker.resolve_auth_state()
        else:
            cookie_enabled = self.settings.bilibili_cookie_enabled if self.settings is not None else False
            cookie_active = self.settings.bilibili_cookie_active if self.settings is not None else False
            cookie_stored = self.settings.bilibili_cookie_configured if self.settings is not None else False
            state = BilibiliAuthState(
                cookie_header=self.settings.bilibili_cookie_value if self.settings is not None else "",
                mode="manual_cookie" if cookie_active else "public",
                source=self.settings.bilibili_cookie_source if self.settings is not None else "none",
                source_label="手动提供的登录状态" if cookie_active else "公开可见内容",
                enabled=cookie_enabled,
                active=cookie_active,
                stored=cookie_stored,
                browser_bridge_enabled=False,
                browser_bridge_active=False,
                browser_bridge_source_label="",
            )

        self._http.cookie = state.cookie_header or None
        return state

    def parse(self, raw_url: str, *, note_style: str = "structured", summary_focus: str = "") -> dict[str, Any]:
        auth_state = self._resolve_auth_state()
        normalized_input = self._normalize_input(raw_url)
        resolved_url = self._url_resolver(normalized_input)
        bvid = self._extract_bvid(resolved_url) or self._extract_bvid(normalized_input)
        if not bvid:
            raise BilibiliParseError("未能从链接中识别 B 站 BV 号")

        selected_page = self._extract_page_number(resolved_url) or self._extract_page_number(normalized_input)
        canonical_source_url = self._build_canonical_video_url(bvid, selected_page)
        subtitle_error: str | None = None
        asr_error: str | None = None
        audio_source_url: str | None = None
        subtitle_need_login = False
        subtitle_preview_toast: str | None = None
        video, parse_mode, metadata_fetch_errors = self._resolve_video_metadata(
            resolved_url,
            bvid,
            page_number=selected_page,
            allow_stub=True,
        )

        try:
            subtitle_result = self._fetch_subtitle_segments(video.bvid, video.cid)
            transcript_segments = subtitle_result.segments
            subtitle_count = subtitle_result.subtitle_count
            subtitle_need_login = subtitle_result.need_login
            subtitle_preview_toast = subtitle_result.preview_toast
        except BilibiliParseError as exc:
            transcript_segments, subtitle_count = [], 0
            subtitle_error = str(exc)

        transcript_source = "subtitle" if transcript_segments else "unavailable"
        timestamps_estimated = False
        asr_used = False
        asr_model_used = ""
        asr_model_auto_upgraded = False
        asr_language = ""
        asr_quality_preset = ""
        asr_strategy_label = ""
        asr_attempt_count = 0
        asr_prompt_used = ""
        asr_context_terms: list[str] = []
        semantic_term_repair_mode = ""
        semantic_term_repair_count = 0
        semantic_term_repair_terms: list[str] = []

        if not transcript_segments:
            try:
                audio_source_url = self._fetch_audio_url(video.bvid, video.cid)
                if audio_source_url and self.asr_gateway is not None and self.asr_gateway.is_enabled():
                    asr_result = self._transcribe_bilibili_audio(
                        audio_source_url,
                        video=video,
                    )
                    asr_text = (asr_result or {}).get("text", "").strip() if asr_result else ""
                    asr_segments = self._build_asr_segments((asr_result or {}).get("segments")) if asr_result else []
                    asr_model_used = str((asr_result or {}).get("model_used") or "").strip()
                    asr_model_auto_upgraded = bool((asr_result or {}).get("model_auto_upgraded"))
                    asr_language = str((asr_result or {}).get("language") or "").strip()
                    asr_quality_preset = str((asr_result or {}).get("quality_preset") or "").strip()
                    asr_strategy_label = str((asr_result or {}).get("strategy_label") or "").strip()
                    asr_attempt_count = int((asr_result or {}).get("attempt_count") or 0)
                    asr_prompt_used = str((asr_result or {}).get("prompt_used") or "").strip()
                    raw_asr_context_terms = (asr_result or {}).get("context_terms") if asr_result else []
                    if isinstance(raw_asr_context_terms, list):
                        asr_context_terms = [str(item).strip() for item in raw_asr_context_terms if str(item).strip()]
                    if asr_segments:
                        transcript_segments = asr_segments
                        transcript_source = "asr"
                        timestamps_estimated = False
                        asr_used = True
                    elif asr_text:
                        transcript_segments = self._build_synthetic_segments(
                            asr_text,
                            duration_seconds=video.duration,
                            source_kind="asr",
                            quality_level="estimated",
                        )
                        transcript_source = "asr"
                        timestamps_estimated = True
                        asr_used = True
                    else:
                        asr_error = "音频转写未返回可用正文"
            except BilibiliParseError as exc:
                asr_error = str(exc)

        description = (video.description or "").strip()
        if not transcript_segments and description:
            transcript_segments = self._build_description_segments(description)
            transcript_source = "description"

        raw_content_text = self._build_content_text(transcript_segments)
        semantic_source_segments = transcript_segments
        if transcript_source == "asr" and transcript_segments:
            semantic_source_segments, repair_info = self._build_asr_semantic_source_segments(
                transcript_segments,
                video=video,
                context_terms=asr_context_terms,
            )
            semantic_term_repair_mode = str(repair_info.get("mode") or "").strip()
            semantic_term_repair_count = int(repair_info.get("count") or 0)
            raw_semantic_terms = repair_info.get("terms")
            if isinstance(raw_semantic_terms, list):
                semantic_term_repair_terms = [str(item).strip() for item in raw_semantic_terms if str(item).strip()]
        semantic_transcript_segments = self._build_semantic_transcript_segments(
            semantic_source_segments,
            transcript_source=transcript_source,
        )
        content_text = self._build_content_text(semantic_transcript_segments or transcript_segments) or description.strip()
        if not content_text:
            content_text = f"《{video.title}》当前未抓取到字幕与简介，可稍后重试。"
        noisy_asr_detected = (
            transcript_source == "asr"
            and self._looks_like_noisy_transcript(raw_content_text or content_text, title=video.title, description=description)
        )

        timestamps_available = any(item.start_ms is not None for item in transcript_segments)
        asr_status = (
            self.asr_gateway.runtime_service.build_status_payload()
            if self.asr_gateway is not None
            else AsrRuntimeService(self.settings).build_status_payload()
        )
        asr_configured = bool(asr_status["available"])
        audio_available = bool(audio_source_url)
        cookie_stored = auth_state.stored
        cookie_enabled = auth_state.enabled
        cookie_active = auth_state.active
        capture_state = self._build_capture_state(
            transcript_source=transcript_source,
            subtitle_need_login=subtitle_need_login,
            cookie_enabled=cookie_enabled,
            cookie_stored=cookie_stored,
            cookie_active=cookie_active,
            audio_available=audio_available,
            asr_configured=asr_configured,
            asr_error=asr_error,
            timestamps_available=timestamps_available,
            timestamps_estimated=timestamps_estimated,
        )

        raw_transcript_markdown = self._build_raw_transcript_markdown(
            title=video.title,
            source_url=canonical_source_url,
            transcript_segments=transcript_segments,
            transcript_source=transcript_source,
            capture_state=capture_state,
        )
        summary = self._build_summary(
            video,
            content_text,
            description=description,
            capture_state=capture_state,
            transcript_source=transcript_source,
            noisy_asr_detected=noisy_asr_detected,
        )
        key_points = self._build_key_points(
            content_text,
            description,
            title=video.title,
            transcript_source=transcript_source,
            noisy_asr_detected=noisy_asr_detected,
        )
        key_points = self._decorate_key_points(key_points, capture_state=capture_state, content_text=content_text)
        tags = self._build_tags(video)
        note_markdown = self._build_note_markdown(
            video,
            canonical_source_url,
            summary,
            key_points,
            content_text,
            transcript_segments=transcript_segments,
            note_style=note_style,
            summary_focus=summary_focus,
            transcript_source=transcript_source,
            capture_state=capture_state,
            timestamps_available=timestamps_available,
            timestamps_estimated=timestamps_estimated,
        )

        llm_enhanced = self._enhance_with_llm(
            video=video,
            source_url=canonical_source_url,
            content_text=content_text,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        if llm_enhanced is not None:
            summary = llm_enhanced.get("summary") or summary
            key_points = llm_enhanced.get("key_points") or key_points
            note_markdown = llm_enhanced.get("note_markdown") or note_markdown

        return {
            "source_type": "url",
            "platform": "bilibili",
            "source_url": canonical_source_url,
            "title": video.title,
            "author": video.author,
            "content_text": content_text,
            "summary": summary,
            "key_points": key_points,
            "quotes": [],
            "category": "B站收藏",
            "content_type": "video",
            "use_case": "学习",
            "tags": tags,
            "metadata": {
                "bvid": video.bvid,
                "cid": video.cid,
                "cover": video.cover,
                "duration": video.duration,
                "view": video.view,
                "like": video.like,
                "pubdate": video.pubdate,
                "subtitle_count": subtitle_count,
                "has_subtitle": bool(subtitle_count),
                "description_length": len(description),
                "source_description": description,
                "parse_mode": parse_mode,
                "metadata_fetch_errors": metadata_fetch_errors,
                "subtitle_error": subtitle_error,
                "subtitle_login_required": subtitle_need_login,
                "subtitle_preview_toast": subtitle_preview_toast,
                "asr_error": asr_error,
                "asr_used": asr_used,
                "audio_source_url": audio_source_url,
                "audio_available": audio_available,
                "asr_configured": asr_configured,
                "asr_selected": asr_status["selected"],
                "asr_config_mode": self.settings.asr_config_mode if self.settings is not None else "disabled",
                "asr_provider": asr_status["provider"],
                "asr_model": asr_status["model"],
                "asr_local_runtime_ready": asr_status["local_runtime_ready"],
                "asr_local_engine": asr_status["local_engine"],
                "asr_runtime_summary": asr_status["runtime_summary"],
                "asr_summary": asr_status["summary"],
                "asr_recommended_action": asr_status["recommended_action"],
                "asr_model_used": asr_model_used,
                "asr_model_auto_upgraded": asr_model_auto_upgraded,
                "asr_language": asr_language,
                "asr_quality_preset": asr_quality_preset,
                "asr_strategy_label": asr_strategy_label,
                "asr_attempt_count": asr_attempt_count,
                "asr_prompt_used": asr_prompt_used,
                "asr_context_terms": asr_context_terms,
                "semantic_term_repair_mode": semantic_term_repair_mode,
                "semantic_term_repair_count": semantic_term_repair_count,
                "semantic_term_repair_terms": semantic_term_repair_terms,
                "noisy_asr_detected": noisy_asr_detected,
                "note_style": note_style,
                "summary_focus": summary_focus,
                "note_markdown": note_markdown,
                "refined_note_markdown": note_markdown,
                "raw_transcript_markdown": raw_transcript_markdown,
                "transcript_segments": [self._serialize_segment(item, canonical_source_url) for item in transcript_segments],
                "transcript_source": transcript_source,
                "timestamps_available": timestamps_available,
                "timestamps_estimated": timestamps_estimated,
                "llm_enhanced": bool(llm_enhanced),
                "raw_content_text": raw_content_text,
                "semantic_content_text": content_text,
                "capture_status": capture_state["status"],
                "capture_quality": capture_state["quality"],
                "capture_summary": capture_state["summary"],
                "capture_recommended_action": capture_state["recommended_action"],
                "capture_blocked_reason": capture_state["blocked_reason"],
                "model_provider": self.settings.model_provider if self.settings is not None else "builtin",
                "cookie_enabled": cookie_enabled,
                "cookie_active": cookie_active,
                "cookie_stored": cookie_stored,
                "cookie_configured": cookie_stored,
                "cookie_source": auth_state.source,
                "auth_mode": auth_state.mode,
                "auth_source_label": auth_state.source_label,
                "browser_bridge_enabled": auth_state.browser_bridge_enabled,
                "browser_bridge_active": auth_state.browser_bridge_active,
                "browser_bridge_source_label": auth_state.browser_bridge_source_label,
                "semantic_transcript_ready": bool(semantic_transcript_segments),
                "semantic_transcript_segments": [
                    self._serialize_segment(item, canonical_source_url) for item in semantic_transcript_segments
                ],
                "page_number": selected_page or 1,
                "source_url_original": resolved_url,
            },
            "local_path": None,
            "status": capture_state["status"],
        }

    def probe(self, raw_url: str) -> dict[str, Any]:
        auth_state = self._resolve_auth_state()
        normalized_input = self._normalize_input(raw_url)
        resolved_url = self._url_resolver(normalized_input)
        bvid = self._extract_bvid(resolved_url) or self._extract_bvid(normalized_input)
        if not bvid:
            raise BilibiliParseError("未能从链接中识别 B 站 BV 号")

        selected_page = self._extract_page_number(resolved_url) or self._extract_page_number(normalized_input)
        canonical_source_url = self._build_canonical_video_url(bvid, selected_page)
        video, parse_mode, metadata_fetch_errors = self._resolve_video_metadata(
            resolved_url,
            bvid,
            page_number=selected_page,
            allow_stub=True,
        )

        subtitle_count = 0
        subtitle_need_login = False
        subtitle_preview_toast: str | None = None
        subtitle_error: str | None = None
        timestamps_available = False
        if video.cid:
            try:
                subtitle_overview = self._fetch_subtitle_overview(video.bvid, video.cid)
                subtitle_count = len(subtitle_overview["items"])
                subtitle_need_login = bool(subtitle_overview["need_login"])
                subtitle_preview_toast = subtitle_overview["preview_toast"]
                timestamps_available = subtitle_count > 0
            except BilibiliParseError as exc:
                subtitle_error = str(exc)

        audio_available = False
        audio_error: str | None = None
        if video.cid:
            try:
                audio_available = bool(self._fetch_audio_url(video.bvid, video.cid))
            except BilibiliParseError as exc:
                audio_error = str(exc)

        cookie_stored = auth_state.stored
        cookie_enabled = auth_state.enabled
        cookie_active = auth_state.active
        asr_status = (
            self.asr_gateway.runtime_service.build_status_payload()
            if self.asr_gateway is not None
            else AsrRuntimeService(self.settings).build_status_payload()
        )
        asr_configured = bool(asr_status["available"])
        predicted_status, predicted_quality, predicted_summary, predicted_action = self._build_probe_prediction(
            subtitle_count=subtitle_count,
            subtitle_need_login=subtitle_need_login,
            cookie_enabled=cookie_enabled,
            cookie_stored=cookie_stored,
            cookie_active=cookie_active,
            audio_available=audio_available,
            asr_configured=asr_configured,
        )

        return {
            "platform": "bilibili",
            "source_url": canonical_source_url,
            "source_url_original": resolved_url,
            "title": video.title,
            "author": video.author,
            "parse_mode": parse_mode,
            "metadata_fetch_errors": metadata_fetch_errors,
            "bvid": video.bvid,
            "cid": video.cid,
            "page_number": selected_page or 1,
            "duration": video.duration,
            "cover": video.cover,
            "subtitle_count": subtitle_count,
            "subtitle_available": subtitle_count > 0,
            "subtitle_login_required": subtitle_need_login,
            "subtitle_preview_toast": subtitle_preview_toast,
            "subtitle_error": subtitle_error,
            "audio_available": audio_available,
            "audio_error": audio_error,
            "cookie_enabled": cookie_enabled,
            "cookie_active": cookie_active,
            "cookie_stored": cookie_stored,
            "cookie_configured": cookie_stored,
            "cookie_source": auth_state.source,
            "auth_mode": auth_state.mode,
            "auth_source_label": auth_state.source_label,
            "browser_bridge_enabled": auth_state.browser_bridge_enabled,
            "browser_bridge_active": auth_state.browser_bridge_active,
            "browser_bridge_source_label": auth_state.browser_bridge_source_label,
            "asr_configured": asr_configured,
            "asr_selected": asr_status["selected"],
            "asr_config_mode": self.settings.asr_config_mode if self.settings is not None else "disabled",
            "asr_provider": asr_status["provider"],
            "asr_model": asr_status["model"],
            "asr_local_runtime_ready": asr_status["local_runtime_ready"],
            "asr_local_engine": asr_status["local_engine"],
            "asr_runtime_summary": asr_status["runtime_summary"],
            "timestamps_available": timestamps_available,
            "predicted_status": predicted_status,
            "predicted_quality": predicted_quality,
            "predicted_summary": predicted_summary,
            "predicted_recommended_action": predicted_action,
        }

    def _normalize_input(self, raw_url: str) -> str:
        candidate = raw_url.strip()
        if not candidate:
            raise BilibiliParseError("链接为空")

        url_match = URL_PATTERN.search(candidate)
        if url_match:
            candidate = url_match.group(0)

        page_number = self._extract_page_number(candidate)
        bvid_match = BVID_PATTERN.search(candidate)
        if bvid_match:
            bvid = self._normalize_bvid(bvid_match.group(1))
            return self._build_canonical_video_url(bvid, page_number)

        if not candidate.startswith(("http://", "https://")):
            return f"https://{candidate}"
        return candidate

    def _build_headers(self, extra_headers: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "User-Agent": BILIBILI_BROWSER_UA,
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }
        if self.settings is not None and self.settings.bilibili_cookie_value:
            headers["Cookie"] = self.settings.bilibili_cookie_value
        if extra_headers:
            headers.update(extra_headers)
        return headers

    def _build_cookie_retry_action(
        self,
        *,
        cookie_enabled: bool,
        cookie_stored: bool,
        retry_label: str,
    ) -> str:
        if cookie_stored and not cookie_enabled:
            return (
                "当前已经保存 B 站 Cookie，但仍处于公开链路优先模式；"
                f"请先在设置页打开“启用 Cookie 增强抓取”，再{retry_label}。"
            )
        if cookie_enabled and not cookie_stored:
            return (
                "当前已经打开 Cookie 增强抓取，但还没有检测到可用 Cookie；"
                f"请先补充 Cookie 内容后再{retry_label}。"
            )
        return f"请先在设置页配置并启用 B 站 Cookie 增强抓取，再{retry_label}。"

    def _build_cookie_follow_up_hint(
        self,
        *,
        cookie_enabled: bool,
        cookie_stored: bool,
    ) -> str:
        if cookie_stored and not cookie_enabled:
            return "在设置页打开已保存的 Cookie 增强抓取后重试"
        if cookie_enabled and not cookie_stored:
            return "补充可用 Cookie 后重试"
        return "配置并启用 B 站 Cookie 增强抓取后重试"

    def _resolve_video_metadata(
        self,
        resolved_url: str,
        bvid: str,
        *,
        page_number: int | None = None,
        allow_stub: bool = False,
    ) -> tuple[BilibiliVideo, str, list[str]]:
        errors: list[str] = []
        try:
            view_payload = self._json_fetcher(
                f"https://api.bilibili.com/x/web-interface/view?{urlencode({'bvid': bvid})}"
            )
            return self._parse_view_payload(bvid, view_payload, page_number=page_number), "api", errors
        except BilibiliParseError as exc:
            errors.append(str(exc))

        try:
            video = self._parse_public_page(
                resolved_url,
                bvid,
                fallback_error=errors[-1] if errors else "访问 B 站页面失败",
                page_number=page_number,
            )
            return video, "public_page", errors
        except BilibiliParseError as exc:
            errors.append(str(exc))

        if allow_stub:
            return self._build_video_stub(bvid, page_number=page_number), "stub", errors

        raise BilibiliParseError(errors[-1] if errors else "未能获取 B 站视频信息")

    def _resolve_url(self, url: str) -> str:
        request = Request(
            url,
            headers=self._build_headers(),
            method="GET",
        )
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                return response.geturl()
        except Exception as exc:
            if "b23.tv" in url.lower():
                raise BilibiliParseError("B 站短链解析失败") from exc
            return url

    def _fetch_json(self, url: str) -> dict[str, Any]:
        payload = ""
        last_error: Exception | None = None
        attempt_headers = (
            {
                "Accept": "application/json, text/plain, */*",
                "X-Requested-With": "XMLHttpRequest",
            },
            {
                "Accept": "application/json, text/plain, */*",
                "Sec-Fetch-Site": "same-site",
                "Sec-Fetch-Mode": "cors",
            },
        )
        for extra_headers in attempt_headers:
            request = Request(
                url,
                headers=self._build_headers(extra_headers),
            )
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    payload = response.read().decode("utf-8", errors="ignore")
                    last_error = None
                    break
            except Exception as exc:
                last_error = exc

        if last_error is not None:
            raise BilibiliParseError("访问 B 站接口失败") from last_error

        try:
            data = json.loads(payload)
        except Exception as exc:
            raise BilibiliParseError("B 站接口返回了无效 JSON") from exc

        if isinstance(data, dict) and data.get("code") not in (None, 0):
            raise BilibiliParseError(data.get("message") or "B 站接口返回异常")
        return data

    def _fetch_text(self, url: str) -> str:
        last_error: Exception | None = None
        attempt_headers = (
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Upgrade-Insecure-Requests": "1",
            },
            {
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-Fetch-User": "?1",
            },
        )
        for extra_headers in attempt_headers:
            request = Request(
                url,
                headers=self._build_headers(extra_headers),
            )
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    return response.read().decode("utf-8", errors="ignore")
            except Exception as exc:
                last_error = exc

        raise BilibiliParseError("访问 B 站页面失败") from last_error

    def _extract_bvid(self, value: str) -> str | None:
        match = BVID_PATTERN.search(value)
        if not match:
            return None
        return self._normalize_bvid(match.group(1))

    def _extract_page_number(self, value: str) -> int | None:
        try:
            query = parse_qs(urlparse(value).query)
        except Exception:
            return None
        raw_page = (query.get("p") or [""])[0].strip()
        if not raw_page:
            return None
        try:
            page_number = int(raw_page)
        except ValueError:
            return None
        return page_number if page_number > 0 else None

    def _select_page(self, pages: list[dict[str, Any]], page_number: int | None) -> dict[str, Any]:
        if not pages:
            return {}
        if page_number is None:
            return pages[0]
        page_index = page_number - 1
        if 0 <= page_index < len(pages):
            return pages[page_index]
        return pages[0]

    def _build_video_title(self, base_title: str, page: dict[str, Any] | None) -> str:
        title = (base_title or "").strip()
        page_part = ((page or {}).get("part") or "").strip()
        if not page_part or page_part == title:
            return title
        return f"{title} · {page_part}"

    def _build_canonical_video_url(self, bvid: str, page_number: int | None = None) -> str:
        base_url = f"https://www.bilibili.com/video/{bvid}"
        if page_number and page_number > 1:
            return f"{base_url}?p={page_number}"
        return base_url

    def _normalize_bvid(self, raw_bvid: str) -> str:
        if len(raw_bvid) < 2:
            return raw_bvid
        return f"BV{raw_bvid[2:]}"

    def _parse_public_page(self, url: str, bvid: str, *, fallback_error: str, page_number: int | None = None) -> BilibiliVideo:
        html = ""
        last_error: BilibiliParseError | None = None
        candidate_urls: list[str] = []
        for candidate in (url, self._build_canonical_video_url(bvid, page_number)):
            if candidate and candidate not in candidate_urls:
                candidate_urls.append(candidate)

        for candidate in candidate_urls:
            try:
                html = self._text_fetcher(candidate)
                break
            except BilibiliParseError as exc:
                last_error = exc

        if not html:
            if last_error is not None:
                raise last_error
            raise BilibiliParseError(fallback_error)

        initial_state = self._extract_initial_state(html)
        if initial_state:
            video = self._parse_initial_state(initial_state, bvid, page_number=page_number)
            if video:
                return video

        title = self._extract_meta(html, "og:title") or self._extract_title_tag(html) or f"B站视频 {bvid}"
        description = self._extract_meta(html, "description") or self._extract_meta(html, "og:description") or fallback_error
        cover = self._extract_meta(html, "og:image")
        author = self._extract_meta(html, "author")

        return BilibiliVideo(
            bvid=bvid,
            cid=0,
            title=unescape(title).strip(),
            author=unescape(author).strip() if author else None,
            description=unescape(description).strip(),
            cover=cover,
            duration=None,
            view=None,
            like=None,
            pubdate=None,
            tag_name=None,
        )

    def _extract_initial_state(self, html: str) -> dict[str, Any] | None:
        patterns = (
            r"window\.__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;",
            r"__INITIAL_STATE__\s*=\s*(\{.*?\})\s*;",
        )
        for pattern in patterns:
            match = re.search(pattern, html, re.DOTALL)
            if not match:
                continue
            try:
                return json.loads(match.group(1))
            except Exception:
                continue
        return None

    def _parse_initial_state(self, state: dict[str, Any], bvid: str, *, page_number: int | None = None) -> BilibiliVideo | None:
        video_data = state.get("videoData") or {}
        if not video_data:
            return None

        owner = video_data.get("owner") or {}
        stat = video_data.get("stat") or {}
        pages = video_data.get("pages") or []
        primary_page = self._select_page(pages, page_number)

        return BilibiliVideo(
            bvid=bvid,
            cid=int((primary_page or {}).get("cid") or video_data.get("cid") or 0),
            title=self._build_video_title(video_data.get("title") or f"B站视频 {bvid}", primary_page),
            author=(owner.get("name") or "").strip() or None,
            description=unescape((video_data.get("desc") or "").strip()),
            cover=video_data.get("pic"),
            duration=(primary_page or {}).get("duration") or video_data.get("duration"),
            view=stat.get("view"),
            like=stat.get("like"),
            pubdate=video_data.get("pubdate"),
            tag_name=video_data.get("tname"),
        )

    def _extract_meta(self, html: str, name: str) -> str | None:
        patterns = (
            rf'<meta[^>]+property=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]+content=["\']([^"\']+)["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(name)}["\']',
            rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']{re.escape(name)}["\']',
        )
        for pattern in patterns:
            match = re.search(pattern, html, re.IGNORECASE)
            if match:
                return unescape(match.group(1)).strip()
        return None

    def _extract_title_tag(self, html: str) -> str | None:
        match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
        if not match:
            return None
        title = unescape(match.group(1)).strip()
        return title.replace("_哔哩哔哩_bilibili", "").strip()

    def _parse_view_payload(self, bvid: str, payload: dict[str, Any], *, page_number: int | None = None) -> BilibiliVideo:
        data = payload.get("data") or {}
        pages = data.get("pages") or []
        if not pages:
            raise BilibiliParseError("B 站视频信息不完整，未找到分 P 数据")

        primary_page = self._select_page(pages, page_number)
        owner = data.get("owner") or {}
        stat = data.get("stat") or {}

        return BilibiliVideo(
            bvid=bvid,
            cid=int((primary_page or {}).get("cid") or 0),
            title=self._build_video_title(data.get("title") or f"B站视频 {bvid}", primary_page),
            author=(owner.get("name") or "").strip() or None,
            description=unescape((data.get("desc") or "").strip()),
            cover=data.get("pic"),
            duration=(primary_page or {}).get("duration") or data.get("duration"),
            view=stat.get("view"),
            like=stat.get("like"),
            pubdate=data.get("pubdate"),
            tag_name=data.get("tname"),
        )

    def _build_video_stub(self, bvid: str, *, page_number: int | None = None) -> BilibiliVideo:
        title = f"B站视频 {bvid}"
        if page_number and page_number > 1:
            title = f"{title} · P{page_number}"
        return BilibiliVideo(
            bvid=bvid,
            cid=0,
            title=title,
            author=None,
            description="",
            cover=None,
            duration=None,
            view=None,
            like=None,
            pubdate=None,
            tag_name=None,
        )


    def _fetch_audio_url(self, bvid: str, cid: int) -> str | None:
        if not cid:
            raise BilibiliParseError("当前视频缺少 cid，无法获取音频地址")

        payload = self._json_fetcher(
            f"https://api.bilibili.com/x/player/playurl?{urlencode({'bvid': bvid, 'cid': cid, 'fnval': 16})}"
        )
        data = payload.get("data") or {}
        dash = data.get("dash") or {}
        audio_items = dash.get("audio") or []
        if not audio_items:
            raise BilibiliParseError("当前视频未返回可用音频流")

        primary_audio = audio_items[0]
        return primary_audio.get("baseUrl") or primary_audio.get("base_url")

    def _fetch_subtitle_overview(self, bvid: str, cid: int) -> dict[str, Any]:
        if not cid:
            return {"items": [], "need_login": False, "preview_toast": None}

        try:
            subtitle_payload = self._json_fetcher(
                f"https://api.bilibili.com/x/player/wbi/v2?{urlencode({'bvid': bvid, 'cid': cid})}"
            )
        except BilibiliParseError:
            subtitle_payload = self._json_fetcher(
                f"https://api.bilibili.com/x/player/v2?{urlencode({'bvid': bvid, 'cid': cid})}"
            )
        subtitle_data = ((subtitle_payload.get("data") or {}).get("subtitle") or {})
        subtitle_items = subtitle_data.get("subtitles") or []
        need_login = bool((subtitle_payload.get("data") or {}).get("need_login_subtitle"))
        preview_toast = (subtitle_payload.get("data") or {}).get("preview_toast")
        return {
            "items": subtitle_items,
            "need_login": need_login,
            "preview_toast": str(preview_toast).strip() if isinstance(preview_toast, str) and preview_toast.strip() else None,
        }

    def _fetch_subtitle_segments(self, bvid: str, cid: int) -> SubtitleFetchResult:
        if not cid:
            return SubtitleFetchResult(segments=[], subtitle_count=0, need_login=False, preview_toast=None)

        subtitle_overview = self._fetch_subtitle_overview(bvid, cid)
        subtitle_items = subtitle_overview["items"]
        need_login = bool(subtitle_overview["need_login"])
        preview_toast = subtitle_overview["preview_toast"]
        if not subtitle_items:
            return SubtitleFetchResult(
                segments=[],
                subtitle_count=0,
                need_login=need_login,
                preview_toast=preview_toast,
            )

        preferred_items = [self._pick_preferred_subtitle(subtitle_items)]
        segments: list[TranscriptSegment] = []
        for item in preferred_items:
            subtitle_url = item.get("subtitle_url")
            if not subtitle_url:
                continue
            if subtitle_url.startswith("//"):
                subtitle_url = f"https:{subtitle_url}"
            body_payload = self._json_fetcher(subtitle_url)
            body_items = body_payload.get("body") or []
            for row in body_items:
                content = (row.get("content") or "").strip()
                if content:
                    segments.append(
                        TranscriptSegment(
                            start_ms=self._to_milliseconds(row.get("from")),
                            end_ms=self._to_milliseconds(row.get("to")),
                            text=content,
                            source_kind="subtitle",
                            quality_level="high",
                        )
                    )

        return SubtitleFetchResult(
            segments=self._compact_segments(self._dedupe_segments(segments)),
            subtitle_count=len(subtitle_items),
            need_login=need_login,
            preview_toast=preview_toast,
        )

    def _pick_preferred_subtitle(self, subtitle_items: list[dict[str, Any]]) -> dict[str, Any]:
        def score(item: dict[str, Any]) -> tuple[int, int]:
            language = f"{item.get('lan', '')} {item.get('lan_doc', '')}".lower()
            chinese_score = 2 if any(token in language for token in ("zh", "中文", "汉")) else 0
            manual_score = 1 if "自动" not in language and "auto" not in language else 0
            return chinese_score, manual_score

        return max(subtitle_items, key=score)

    def _transcribe_bilibili_audio(
        self,
        audio_source_url: str,
        *,
        video: BilibiliVideo,
    ) -> dict[str, Any] | None:
        if self.asr_gateway is None or not self.asr_gateway.is_enabled():
            return None

        context_terms = self._extract_asr_context_terms(video)
        context_prompt = self._build_asr_context_prompt(video, context_terms=context_terms)
        strategies = self._build_bilibili_asr_strategies(
            context_prompt=context_prompt,
            video=video,
        )
        candidates = self.asr_gateway.transcribe_audio_url_with_strategies(
            audio_source_url,
            filename_hint=f"{video.bvid}.m4a",
            strategies=strategies,
        )
        if not candidates:
            return None

        best_result: dict[str, Any] | None = None
        best_score: int | None = None
        for candidate in candidates:
            score = self._score_asr_result(candidate, video=video, context_terms=context_terms)
            candidate["quality_score"] = score
            if best_result is None or best_score is None or score > best_score:
                best_result = candidate
                best_score = score

        if best_result is None:
            return None

        best_result["attempt_count"] = len(candidates)
        best_result["context_terms"] = context_terms
        return best_result

    def _build_bilibili_asr_strategies(
        self,
        *,
        context_prompt: str,
        video: BilibiliVideo,
    ) -> list[dict[str, Any]]:
        strategies = [
            {
                "label": "mixed_auto",
                "language": None,
                "quality_preset": "video_mixed",
                "prompt": context_prompt,
            },
        ]

        duration_seconds = int(video.duration or 0)
        is_long_form = duration_seconds >= 22 * 60
        if not is_long_form:
            strategies.append(
                {
                    "label": "zh_prompted",
                    "language": "zh",
                    "quality_preset": "video_zh",
                    "prompt": context_prompt,
                }
            )

        return strategies

    def _score_asr_result(
        self,
        result: dict[str, Any],
        *,
        video: BilibiliVideo,
        context_terms: list[str],
    ) -> int:
        text = str(result.get("text") or "").strip()
        if not text:
            return -1000

        segments = self._build_asr_segments(result.get("segments"))
        compact_text = re.sub(r"\s+", " ", text).strip()
        normalized_text = re.sub(r"\s+", "", compact_text)
        lowered_text = compact_text.lower()

        score = 32
        if segments:
            score += 16
            if any(item.start_ms is not None for item in segments):
                score += 6
        elif len(compact_text) >= 120:
            score += 4

        if self._looks_like_noisy_transcript(compact_text, title=video.title, description=video.description):
            score -= 18
        else:
            score += 12

        punctuation_density = len(re.findall(r"[，。！？；：、“”,.!?;:]", compact_text)) / max(len(compact_text), 1)
        if punctuation_density >= 0.014:
            score += 5
        elif len(compact_text) >= 140:
            score -= 6

        english_terms = [item for item in context_terms if re.search(r"[A-Za-z]", item)]
        chinese_terms = [item for item in context_terms if not re.search(r"[A-Za-z]", item)]
        english_hits = sum(1 for item in english_terms if item.lower() in lowered_text)
        chinese_hits = sum(1 for item in chinese_terms if re.sub(r"\s+", "", item) in normalized_text)
        score += min(24, english_hits * 8)
        score += min(18, chinese_hits * 4)

        if english_terms and english_hits == 0:
            score -= min(12, len(english_terms) * 3)
        if chinese_terms and chinese_hits == 0:
            score -= 6

        requested_language = str(result.get("language") or "").strip().lower()
        strategy_label = str(result.get("strategy_label") or "").strip().lower()
        if english_hits > 0 and (not requested_language or "mixed" in strategy_label):
            score += 4

        return score

    def _build_asr_context_prompt(self, video: BilibiliVideo, *, context_terms: list[str]) -> str:
        if not context_terms:
            return ""

        english_terms = [item for item in context_terms if re.search(r"[A-Za-z]", item)]
        prompt_parts = [
            "这是一个中文视频，可能夹杂英文专有名词、缩写或游戏术语。",
        ]
        if english_terms:
            prompt_parts.append("请尽量保留英文原词，不要替换成同音汉字。")
        prompt_parts.append(f"可能出现的关键词：{'、'.join(context_terms[:12])}")
        prompt = " ".join(part.strip() for part in prompt_parts if part.strip())
        return prompt[:260]

    def _extract_asr_context_terms(self, video: BilibiliVideo, *, limit: int = 12) -> list[str]:
        stop_terms = {
            "视频",
            "教程",
            "分享",
            "详解",
            "解析",
            "攻略",
            "玩法",
            "内容",
            "作者",
            "官方",
            "哔哩哔哩",
            "bilibili",
        }
        candidates: list[str] = []
        for source in [video.title, video.tag_name or "", video.author or "", video.description]:
            candidates.extend(self._extract_context_terms_from_text(source))

        terms: list[str] = []
        for item in candidates:
            cleaned = item.strip()
            lowered = cleaned.lower()
            if not cleaned or lowered in stop_terms or cleaned in terms:
                continue
            if re.fullmatch(r"\d+", cleaned):
                continue
            terms.append(cleaned)
            if len(terms) >= limit:
                break
        return terms

    def _extract_context_terms_from_text(self, text: str) -> list[str]:
        if not text.strip():
            return []

        terms: list[str] = []
        phrase_pattern = r"[A-Za-z][A-Za-z0-9+._/-]{1,24}(?:\s+[A-Za-z][A-Za-z0-9+._/-]{1,24}){1,3}"
        for item in re.findall(phrase_pattern, text):
            cleaned = re.sub(r"\s+", " ", item).strip(" _-/.,，。！？；：()[]{}\"'")
            if cleaned and cleaned not in terms:
                terms.append(cleaned)

        pattern = r"[A-Za-z][A-Za-z0-9+._/-]{1,24}|[\u4e00-\u9fff]{2,8}"
        for item in re.findall(pattern, text):
            cleaned = item.strip(" _-/.,，。！？；：()[]{}\"'")
            if not cleaned:
                continue
            if cleaned not in terms:
                terms.append(cleaned)
        return terms

    def _build_asr_semantic_source_segments(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        video: BilibiliVideo,
        context_terms: list[str],
    ) -> tuple[list[TranscriptSegment], dict[str, Any]]:
        effective_terms = [item for item in context_terms if item] or self._extract_asr_context_terms(video)
        repaired_segments, deterministic_count = self._repair_segments_with_context_terms(
            transcript_segments,
            context_terms=effective_terms,
        )

        mode = "deterministic" if deterministic_count > 0 else ""
        total_count = deterministic_count
        final_segments = repaired_segments

        if self._should_try_llm_asr_term_repair(repaired_segments, context_terms=effective_terms):
            llm_segments, llm_count = self._repair_asr_segments_with_llm(
                repaired_segments,
                video=video,
                context_terms=effective_terms,
            )
            if llm_count > 0:
                final_segments = llm_segments
                total_count += llm_count
                mode = "deterministic+llm" if deterministic_count > 0 else "llm"

        return final_segments, {
            "mode": mode,
            "count": total_count,
            "terms": effective_terms[:10],
        }

    def _repair_segments_with_context_terms(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        context_terms: list[str],
    ) -> tuple[list[TranscriptSegment], int]:
        repaired_segments: list[TranscriptSegment] = []
        repair_count = 0
        for segment in transcript_segments:
            repaired_text, changed = self._repair_text_with_context_terms(segment.text, context_terms=context_terms)
            repair_count += changed
            if repaired_text != segment.text:
                repaired_segments.append(
                    TranscriptSegment(
                        start_ms=segment.start_ms,
                        end_ms=segment.end_ms,
                        text=repaired_text,
                        source_kind=segment.source_kind,
                        quality_level=segment.quality_level,
                    )
                )
            else:
                repaired_segments.append(segment)
        return repaired_segments, repair_count

    def _repair_text_with_context_terms(self, text: str, *, context_terms: list[str]) -> tuple[str, int]:
        repaired = text.strip()
        if not repaired or not context_terms:
            return repaired, 0

        repair_count = 0
        english_terms = sorted(
            [item for item in context_terms if re.search(r"[A-Za-z]", item)],
            key=lambda item: (len(re.findall(r"[A-Za-z0-9]+", item)), len(item)),
            reverse=True,
        )
        chinese_terms = sorted(
            [item for item in context_terms if not re.search(r"[A-Za-z]", item)],
            key=len,
            reverse=True,
        )

        for term in chinese_terms:
            normalized = self._canonicalize_chinese_term(repaired, term)
            if normalized != repaired:
                repaired = normalized
                repair_count += 1

        for term in english_terms:
            normalized = self._canonicalize_english_term(repaired, term)
            if normalized != repaired:
                repaired = normalized
                repair_count += 1

        repaired, fuzzy_count = self._apply_fuzzy_english_replacements(repaired, english_terms=english_terms)
        repair_count += fuzzy_count
        repaired = re.sub(r"\s+", " ", repaired).strip()
        return repaired, repair_count

    def _canonicalize_chinese_term(self, text: str, term: str) -> str:
        cleaned_term = term.strip()
        if not cleaned_term or cleaned_term in text:
            return text
        pattern = r"\s*".join(re.escape(char) for char in cleaned_term)
        return re.sub(pattern, cleaned_term, text)

    def _canonicalize_english_term(self, text: str, term: str) -> str:
        cleaned_term = re.sub(r"\s+", " ", term).strip()
        if not cleaned_term:
            return text

        if cleaned_term.isupper() and cleaned_term.isalpha() and len(cleaned_term) <= 8:
            pattern = "".join(
                f"{re.escape(char)}(?:[\\s\\-_/\\\\.]*)"
                for char in cleaned_term[:-1]
            ) + re.escape(cleaned_term[-1])
            return re.sub(rf"(?i)(?<![A-Za-z0-9]){pattern}(?![A-Za-z0-9])", cleaned_term, text)

        words = [item for item in re.findall(r"[A-Za-z0-9]+", cleaned_term) if item]
        if not words:
            return text
        flexible = r"(?:[\s\-_./\\]*)".join(re.escape(word) for word in words)
        return re.sub(rf"(?i)(?<![A-Za-z0-9]){flexible}(?![A-Za-z0-9])", cleaned_term, text)

    def _apply_fuzzy_english_replacements(self, text: str, *, english_terms: list[str]) -> tuple[str, int]:
        ascii_matches = list(re.finditer(r"[A-Za-z][A-Za-z0-9+._/-]*", text))
        if not ascii_matches or not english_terms:
            return text, 0

        candidate_replacements: list[tuple[int, int, str, float]] = []
        for term in english_terms:
            term_words = [item for item in re.findall(r"[A-Za-z0-9]+", term) if item]
            if not term_words:
                continue
            term_signature = self._build_ascii_signature(term)
            window_size = len(term_words)

            for start_index in range(len(ascii_matches)):
                end_index = start_index + window_size - 1
                if end_index >= len(ascii_matches):
                    break

                start_match = ascii_matches[start_index]
                end_match = ascii_matches[end_index]
                window_text = text[start_match.start():end_match.end()]
                if re.search(r"[\u4e00-\u9fff]", window_text):
                    continue

                window_signature = self._build_ascii_signature(window_text)
                if not window_signature or window_signature == term_signature:
                    continue

                ratio = SequenceMatcher(None, window_signature, term_signature).ratio()
                threshold = 0.84 if window_size > 1 else 0.88
                length_gap = abs(len(window_signature) - len(term_signature))
                if ratio >= threshold and length_gap <= max(3, len(term_signature) // 3):
                    candidate_replacements.append((start_match.start(), end_match.end(), term, ratio))

            if window_size > 1:
                for match in ascii_matches:
                    token_signature = self._build_ascii_signature(match.group(0))
                    if not token_signature or token_signature == term_signature:
                        continue
                    ratio = SequenceMatcher(None, token_signature, term_signature).ratio()
                    if ratio >= 0.9 and abs(len(token_signature) - len(term_signature)) <= max(4, len(term_signature) // 3):
                        candidate_replacements.append((match.start(), match.end(), term, ratio))

        if not candidate_replacements:
            return text, 0

        candidate_replacements.sort(key=lambda item: (item[3], item[1] - item[0]), reverse=True)
        selected: list[tuple[int, int, str]] = []
        occupied: list[tuple[int, int]] = []
        for start, end, replacement, _score in candidate_replacements:
            if any(not (end <= existing_start or start >= existing_end) for existing_start, existing_end in occupied):
                continue
            selected.append((start, end, replacement))
            occupied.append((start, end))

        if not selected:
            return text, 0

        repaired = self._apply_text_replacements(text, selected)
        return repaired, len(selected)

    def _build_ascii_signature(self, text: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", (text or "").lower())

    def _apply_text_replacements(self, text: str, replacements: list[tuple[int, int, str]]) -> str:
        if not replacements:
            return text

        ordered = sorted(replacements, key=lambda item: item[0])
        parts: list[str] = []
        cursor = 0
        for start, end, replacement in ordered:
            if start < cursor:
                continue
            parts.append(text[cursor:start])
            parts.append(replacement)
            cursor = end
        parts.append(text[cursor:])
        return "".join(parts)

    def _should_try_llm_asr_term_repair(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        context_terms: list[str],
    ) -> bool:
        if self.llm_gateway is None or not self.llm_gateway.is_enabled():
            return False

        english_terms = [item for item in context_terms if re.search(r"[A-Za-z]", item)]
        if not english_terms:
            return False

        text = self._build_content_text(transcript_segments)
        if len(text) < 60:
            return False

        return self._count_context_term_hits(text, english_terms) < min(3, len(english_terms))

    def _repair_asr_segments_with_llm(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        video: BilibiliVideo,
        context_terms: list[str],
    ) -> tuple[list[TranscriptSegment], int]:
        if self.llm_gateway is None:
            return transcript_segments, 0

        repaired_segments: list[TranscriptSegment] = []
        changed_count = 0
        for batch in self._batch_transcript_segments(transcript_segments):
            batch_lines = [item.text for item in batch]
            repaired_lines = self.llm_gateway.repair_asr_transcript_lines(
                title=video.title,
                description=video.description,
                context_terms=context_terms,
                lines=batch_lines,
            )
            if not repaired_lines or len(repaired_lines) != len(batch):
                repaired_segments.extend(batch)
                continue

            for segment, repaired_line in zip(batch, repaired_lines):
                candidate = re.sub(r"^\s*(?:[-*]|\d+[.)])\s*", "", repaired_line or "").strip()
                candidate = re.sub(r"\s+", " ", candidate).strip()
                if self._is_llm_repaired_line_acceptable(segment.text, candidate, context_terms=context_terms):
                    if candidate != segment.text:
                        changed_count += 1
                    repaired_segments.append(
                        TranscriptSegment(
                            start_ms=segment.start_ms,
                            end_ms=segment.end_ms,
                            text=candidate,
                            source_kind=segment.source_kind,
                            quality_level=segment.quality_level,
                        )
                    )
                else:
                    repaired_segments.append(segment)
        return repaired_segments, changed_count

    def _batch_transcript_segments(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        max_segments: int = 10,
        max_chars: int = 1200,
    ) -> list[list[TranscriptSegment]]:
        batches: list[list[TranscriptSegment]] = []
        buffer: list[TranscriptSegment] = []
        buffer_chars = 0
        for segment in transcript_segments:
            segment_length = len(segment.text.strip())
            if buffer and (len(buffer) >= max_segments or buffer_chars + segment_length > max_chars):
                batches.append(buffer)
                buffer = [segment]
                buffer_chars = segment_length
                continue
            buffer.append(segment)
            buffer_chars += segment_length

        if buffer:
            batches.append(buffer)
        return batches

    def _is_llm_repaired_line_acceptable(
        self,
        original: str,
        candidate: str,
        *,
        context_terms: list[str],
    ) -> bool:
        if not candidate:
            return False
        if candidate.startswith("{") or candidate.startswith("["):
            return False

        original_clean = re.sub(r"\s+", " ", original or "").strip()
        candidate_clean = re.sub(r"\s+", " ", candidate or "").strip()
        if candidate_clean == original_clean:
            return True
        if len(candidate_clean) < max(2, int(len(original_clean) * 0.35)):
            return False
        if len(candidate_clean) > max(160, int(len(original_clean) * 2.2)):
            return False

        original_tokens = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", original_clean.lower()))
        candidate_tokens = set(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]{2,}", candidate_clean.lower()))
        overlap = len(original_tokens & candidate_tokens) / max(len(original_tokens), 1)
        hit_gain = self._count_context_term_hits(candidate_clean, context_terms) - self._count_context_term_hits(original_clean, context_terms)
        return overlap >= 0.35 or hit_gain > 0

    def _count_context_term_hits(self, text: str, context_terms: list[str]) -> int:
        compact = re.sub(r"\s+", "", text or "")
        lowered = (text or "").lower()
        hits = 0
        for term in context_terms:
            cleaned_term = str(term or "").strip()
            if not cleaned_term:
                continue
            if re.search(r"[A-Za-z]", cleaned_term):
                signature = self._build_ascii_signature(cleaned_term)
                if signature and signature in self._build_ascii_signature(lowered):
                    hits += 1
            else:
                if re.sub(r"\s+", "", cleaned_term) in compact:
                    hits += 1
        return hits

    def _build_summary(
        self,
        video: BilibiliVideo,
        content_text: str,
        *,
        description: str,
        capture_state: dict[str, str | None],
        transcript_source: str,
        noisy_asr_detected: bool,
    ) -> str:
        if transcript_source == "asr" and noisy_asr_detected:
            return self._build_noisy_asr_summary(
                video=video,
                description=description,
                capture_state=capture_state,
            )

        if content_text:
            sentences = [
                re.sub(r"\s+", " ", item).strip()
                for item in re.split(r"[\n。！？!?]", content_text)
                if re.sub(r"\s+", " ", item).strip()
            ]
            compact = "；".join(sentences[:2]).strip() if sentences else content_text.replace("\n", " ").strip()
            if capture_state["status"] not in {"ready", "ready_estimated"}:
                preview = compact[:72] + ("..." if len(compact) > 72 else "")
                return f"{capture_state['summary']} 当前可用内容：{preview}"
            return compact[:160] + ("..." if len(compact) > 160 else "")
        return f"《{video.title}》已完成解析，但当前未提取到字幕正文。"

    def _build_key_points(
        self,
        content_text: str,
        description: str,
        *,
        title: str,
        transcript_source: str,
        noisy_asr_detected: bool,
    ) -> list[str]:
        if transcript_source == "asr" and noisy_asr_detected:
            return self._build_noisy_asr_key_points(title=title, description=description)

        source = content_text or description
        if not source:
            return ["当前未提取到可生成要点的正文。"]

        candidates = [
            re.sub(r"\s+", " ", segment).strip()
            for segment in re.split(r"[\n。！？!?]", source)
            if re.sub(r"\s+", " ", segment).strip()
        ]
        if not candidates:
            return [source[:80]]

        scored: list[tuple[int, int, str]] = []
        for index, candidate in enumerate(candidates):
            if len(candidate) < 8:
                continue
            score = min(len(candidate), 48)
            if 12 <= len(candidate) <= 72:
                score += 10
            if re.search(r"\d", candidate):
                score += 6
            if any(token in candidate for token in ("建议", "需要", "注意", "不要", "可以", "优先", "关键", "核心", "先", "再", "如果")):
                score += 8
            if candidate.endswith(("？", "?")):
                score -= 6
            scored.append((score, index, candidate))

        if not scored:
            return [source[:80]]

        selected: list[tuple[int, str]] = []
        for _score, index, candidate in sorted(scored, key=lambda item: (-item[0], item[1])):
            if any(candidate in item or item in candidate for _, item in selected):
                continue
            selected.append((index, candidate))
            if len(selected) >= 4:
                break

        return [item for _, item in sorted(selected, key=lambda row: row[0])] or [source[:80]]

    def _build_noisy_asr_summary(
        self,
        *,
        video: BilibiliVideo,
        description: str,
        capture_state: dict[str, str | None],
    ) -> str:
        title = video.title.strip() or "这条视频"
        description_preview = self._truncate_text(description, limit=76)
        parts = [
            f"这条视频围绕《{title}》展开，当前已通过音频转写恢复正文并保留可回看片段。",
        ]
        if description_preview:
            parts.append(f"简介补充：{description_preview}")
        parts.append("由于原始转写存在口语噪声，现阶段更适合围绕具体片段继续提问和核对原视频。")
        return " ".join(parts)

    def _build_noisy_asr_key_points(self, *, title: str, description: str) -> list[str]:
        points: list[str] = []
        cleaned_title = title.strip()
        if cleaned_title:
            points.append(f"视频主题：{cleaned_title}")

        description_sentences = [
            re.sub(r"\s+", " ", item).strip()
            for item in re.split(r"[\n。！？!?]", description or "")
            if re.sub(r"\s+", " ", item).strip()
        ]
        for item in description_sentences[:2]:
            if item and item not in points:
                points.append(item)

        points.append("当前正文来自音频转写，建议围绕时间片段继续提问并核对原视频。")
        points.append("如需更像人工整理的结论，后续可接入理解模型重整精炼层。")
        return points[:4]

    def _looks_like_noisy_transcript(self, text: str, *, title: str, description: str) -> bool:
        cleaned = re.sub(r"\s+", " ", text or "").strip()
        if len(cleaned) < 120:
            return False

        sentences = [
            re.sub(r"\s+", " ", item).strip()
            for item in re.split(r"[\n。！？!?]", cleaned)
            if re.sub(r"\s+", " ", item).strip()
        ]
        sample = sentences[:4] if sentences else [cleaned[:240]]
        avg_length = sum(len(item) for item in sample) / max(len(sample), 1)
        punctuation_density = len(re.findall(r"[，。！？；：、“”,.!?;:]", cleaned)) / max(len(cleaned), 1)
        filler_tokens = ("对不对", "然后", "就是", "这个", "那个", "一下", "是不是", "现在", "我们", "有点")
        filler_hits = sum(cleaned.count(token) for token in filler_tokens)
        repeated_prefix_count = len({item[:18] for item in sample if item[:18]})
        title_terms = self._extract_title_terms(title)
        title_term_hits = sum(1 for term in title_terms if term in cleaned)
        description_hits = 0
        cleaned_transcript = re.sub(r"\s+", "", cleaned)
        for item in [
            re.sub(r"\s+", "", part).strip()
            for part in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,8}", description or "")
        ]:
            if item and item in cleaned_transcript:
                description_hits += 1
                if description_hits >= 2:
                    break

        noisy_signals = 0
        if avg_length > 48:
            noisy_signals += 1
        if punctuation_density < 0.012:
            noisy_signals += 1
        if filler_hits >= 6:
            noisy_signals += 1
        if repeated_prefix_count <= 2 and len(sample) >= 3:
            noisy_signals += 1
        if title_terms and title_term_hits == 0:
            noisy_signals += 1
        if description.strip() and description_hits == 0:
            noisy_signals += 1
        return noisy_signals >= 3

    def _extract_title_terms(self, title: str) -> list[str]:
        stop_terms = {"视频", "内容", "教程", "分享", "详解", "解析", "笔记"}
        terms: list[str] = []
        for item in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}", title or ""):
            cleaned = item.strip()
            if not cleaned or cleaned in stop_terms or cleaned in terms:
                continue
            terms.append(cleaned)
        return terms[:4]

    def _truncate_text(self, text: str, *, limit: int) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip()
        if not cleaned:
            return ""
        return cleaned if len(cleaned) <= limit else f"{cleaned[:limit].rstrip()}..."

    def _build_tags(self, video: BilibiliVideo) -> list[str]:
        tags = ["B站", "视频"]
        if video.tag_name:
            tags.append(video.tag_name)
        deduped: list[str] = []
        for item in tags:
            if item and item not in deduped:
                deduped.append(item)
        return deduped

    def _decorate_key_points(
        self,
        key_points: list[str],
        *,
        capture_state: dict[str, str | None],
        content_text: str,
    ) -> list[str]:
        if capture_state["status"] in {"ready", "ready_estimated"}:
            return key_points

        decorated: list[str] = []
        summary = str(capture_state["summary"] or "").strip()
        action = str(capture_state["recommended_action"] or "").strip()
        if summary:
            decorated.append(summary)
        if action:
            decorated.append(action)

        compact = content_text.replace("\n", " ").strip()
        if compact:
            preview = compact[:80] + ("..." if len(compact) > 80 else "")
            if preview not in decorated:
                decorated.append(preview)

        for item in key_points:
            if item not in decorated:
                decorated.append(item)
        return decorated[:4]

    def _build_note_markdown(
        self,
        video: BilibiliVideo,
        source_url: str,
        summary: str,
        key_points: list[str],
        content_text: str,
        *,
        transcript_segments: list[TranscriptSegment],
        note_style: str,
        summary_focus: str,
        transcript_source: str,
        capture_state: dict[str, str | None],
        timestamps_available: bool,
        timestamps_estimated: bool,
    ) -> str:
        summary_title = "一句话总结"
        points_title = "核心要点"
        body_title = "视频笔记"

        if note_style == "qa":
            summary_title = "问题结论"
            points_title = "关键答案"
            body_title = "问答式笔记"
        elif note_style == "brief":
            summary_title = "快速摘要"
            points_title = "重点摘录"
            body_title = "速记内容"

        lines = [
            f"# {video.title}",
            "",
            "## 视频信息",
            "",
            f"- BVID: {video.bvid}",
            f"- 作者: {video.author or '-'}",
            f"- 链接: {source_url}",
            f"- 时长: {video.duration or '-'} 秒",
            f"- 播放: {video.view or '-'}",
            f"- 点赞: {video.like or '-'}",
            f"- 笔记风格: {note_style}",
            "",
        ]

        lines.extend([
            "## 采集状态",
            "",
            f"- 当前状态: {capture_state['label']}",
            f"- 正文来源: {self._label_transcript_source(transcript_source)}",
            f"- 时间定位: {'已建立估算时间戳' if timestamps_estimated else '已建立时间戳' if timestamps_available else '未建立时间定位'}",
            f"- 当前说明: {capture_state['summary']}",
        ])
        if capture_state["recommended_action"]:
            lines.append(f"- 建议下一步: {capture_state['recommended_action']}")
        lines.append("")

        if summary_focus.strip():
            lines.extend([
                "## 本次关注点",
                "",
                summary_focus.strip(),
                "",
            ])

        lines.extend([
            f"## {summary_title}",
            "",
            summary or "当前没有总结。",
            "",
            f"## {points_title}",
            "",
        ])

        if key_points:
            lines.extend([f"- {item}" for item in key_points])
        else:
            lines.append("- 当前没有提炼出核心要点。")

        timeline_lines = self._build_timeline_lines(transcript_segments)
        if timeline_lines:
            lines.extend([
                "",
                "## 推荐回看片段",
                "",
                *timeline_lines,
            ])

        lines.extend([
            "",
            f"## {body_title}",
            "",
            content_text or "当前没有可用正文。",
            "",
        ])
        return "\n".join(lines)


    def _enhance_with_llm(
        self,
        *,
        video: BilibiliVideo,
        source_url: str,
        content_text: str,
        note_style: str,
        summary_focus: str,
    ) -> dict[str, Any] | None:
        if self.llm_gateway is None:
            return None
        return self.llm_gateway.enhance_import_result(
            title=video.title,
            author=video.author,
            source_url=source_url,
            content_text=content_text,
            note_style=note_style,
            summary_focus=summary_focus,
        )

    def _build_content_text(self, transcript_segments: list[TranscriptSegment]) -> str:
        texts = [item.text.strip() for item in transcript_segments if item.text.strip()]
        return "\n".join(texts).strip()

    def _build_semantic_transcript_segments(
        self,
        transcript_segments: list[TranscriptSegment],
        *,
        transcript_source: str,
    ) -> list[TranscriptSegment]:
        if not transcript_segments:
            return []

        semantic_segments: list[TranscriptSegment] = []
        for segment in transcript_segments:
            normalized_text = self._normalize_semantic_transcript_text(
                segment.text,
                transcript_source=transcript_source,
            )
            if not normalized_text:
                continue

            pieces = self._split_semantic_transcript_text(
                normalized_text,
                transcript_source=transcript_source,
            )
            if not pieces:
                continue

            time_ranges = self._estimate_semantic_time_ranges(segment.start_ms, segment.end_ms, pieces)
            for index, piece in enumerate(pieces):
                start_ms, end_ms = time_ranges[index]
                semantic_segments.append(
                    TranscriptSegment(
                        start_ms=start_ms,
                        end_ms=end_ms,
                        text=piece,
                        source_kind=segment.source_kind,
                        quality_level=segment.quality_level,
                    )
                )

        deduped_segments = self._dedupe_semantic_segments(semantic_segments)
        return self._compact_semantic_segments(deduped_segments)

    def _normalize_semantic_transcript_text(self, text: str, *, transcript_source: str) -> str:
        cleaned = unescape(text or "")
        cleaned = cleaned.replace("\u3000", " ").replace("\r", "\n")
        cleaned = re.sub(r"[ \t]+", " ", cleaned)
        cleaned = re.sub(r"\n{2,}", "\n", cleaned)
        cleaned = re.sub(r"[·•]+", " ", cleaned)
        cleaned = re.sub(r"\s+([，。！？；：、,.!?;:])", r"\1", cleaned)
        cleaned = re.sub(r"([（(【\[])\s+", r"\1", cleaned)
        cleaned = re.sub(r"\s+([）)】\]])", r"\1", cleaned)
        cleaned = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", cleaned)
        cleaned = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[，。！？；：、])", "", cleaned)
        cleaned = re.sub(r"(?<=[，。！？；：、])\s+(?=[\u4e00-\u9fff])", "", cleaned)
        cleaned = re.sub(r"([，。！？；：、,.!?;:])\1{1,}", r"\1", cleaned)
        cleaned = cleaned.strip(" \n\t,，、；;：:")

        if transcript_source == "asr":
            cleaned = self._strip_asr_leading_fillers(cleaned)

        cleaned = re.sub(r"\s*\n\s*", "\n", cleaned).strip()
        return cleaned

    def _strip_asr_leading_fillers(self, text: str) -> str:
        cleaned = text.strip()
        if not cleaned:
            return ""

        filler_pattern = re.compile(r"^(?:嗯+|呃+|额+|啊+|诶+|欸+|哎+|唉+|那个|就是|对吧|是不是)(?:[，,、\s]+|$)")
        for _ in range(2):
            next_cleaned = filler_pattern.sub("", cleaned, count=1).strip()
            if not next_cleaned or next_cleaned == cleaned:
                break
            cleaned = next_cleaned
        return cleaned

    def _split_semantic_transcript_text(self, text: str, *, transcript_source: str) -> list[str]:
        candidates = [item.strip() for item in re.split(r"(?<=[。！？!?；;])\s*|\n+", text) if item.strip()]
        if not candidates:
            candidates = [text.strip()]

        segments: list[str] = []
        for candidate in candidates:
            segments.extend(self._split_semantic_long_text(candidate, transcript_source=transcript_source))

        normalized_segments: list[str] = []
        for item in segments:
            cleaned = item.strip(" \n\t,，、；;：:")
            if not cleaned or not self._is_meaningful_semantic_text(cleaned):
                continue
            if normalized_segments and self._semantic_text_overlaps(normalized_segments[-1], cleaned):
                continue
            normalized_segments.append(cleaned)
        return normalized_segments

    def _split_semantic_long_text(self, text: str, *, transcript_source: str) -> list[str]:
        cleaned = text.strip()
        if not cleaned:
            return []

        max_chars = 84 if transcript_source == "asr" else 96 if transcript_source == "description" else 88
        if len(cleaned) <= max_chars:
            return [cleaned]

        clauses = [item.strip() for item in re.split(r"(?<=[，,、；;：:])\s*|\s{2,}", cleaned) if item.strip()]
        if len(clauses) <= 1:
            return self._split_text_by_length(cleaned, max_chars=max_chars)

        parts: list[str] = []
        buffer = ""
        for clause in clauses:
            candidate = self._join_semantic_text(buffer, clause)
            if buffer and len(candidate) > max_chars:
                parts.append(buffer.strip())
                buffer = clause
                continue
            buffer = candidate

        if buffer:
            parts.append(buffer.strip())

        final_parts: list[str] = []
        for item in parts:
            if len(item) > max_chars:
                final_parts.extend(self._split_text_by_length(item, max_chars=max_chars))
            else:
                final_parts.append(item)
        return final_parts

    def _split_text_by_length(self, text: str, *, max_chars: int) -> list[str]:
        cleaned = text.strip()
        if not cleaned:
            return []

        parts: list[str] = []
        remaining = cleaned
        while len(remaining) > max_chars:
            cut_at = 0
            for delimiter in ("，", "、", "；", "：", ",", ";", ":", " "):
                candidate = remaining.rfind(delimiter, max_chars // 2, max_chars + 1)
                if candidate > cut_at:
                    cut_at = candidate + 1

            if cut_at <= 0:
                cut_at = max_chars

            part = remaining[:cut_at].strip()
            if not part:
                part = remaining[:max_chars].strip()
                cut_at = len(part)

            if not part or part == remaining:
                break

            parts.append(part)
            remaining = remaining[cut_at:].strip()

        if remaining:
            parts.append(remaining)
        return parts

    def _join_semantic_text(self, left: str, right: str) -> str:
        if not left:
            return right.strip()
        if not right:
            return left.strip()

        stripped_left = left.rstrip()
        stripped_right = right.lstrip()
        if stripped_left.endswith(("，", "。", "！", "？", "；", "：", "、", ",", ";", ":", "/", "-")):
            return f"{stripped_left}{stripped_right}"
        if re.search(r"[A-Za-z0-9]$", stripped_left) and re.match(r"^[A-Za-z0-9]", stripped_right):
            return f"{stripped_left} {stripped_right}"
        return f"{stripped_left}{stripped_right}"

    def _is_meaningful_semantic_text(self, text: str) -> bool:
        return len(re.findall(r"[A-Za-z0-9\u4e00-\u9fff]", text)) >= 2

    def _semantic_text_overlaps(self, previous: str, current: str) -> bool:
        previous_signature = self._build_semantic_signature(previous)
        current_signature = self._build_semantic_signature(current)
        if not previous_signature or not current_signature:
            return False
        if previous_signature == current_signature:
            return True
        shorter, longer = (
            (previous_signature, current_signature)
            if len(previous_signature) <= len(current_signature)
            else (current_signature, previous_signature)
        )
        return len(shorter) >= 12 and shorter in longer

    def _build_semantic_signature(self, text: str) -> str:
        return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", text or "").lower()[:160]

    def _estimate_semantic_time_ranges(
        self,
        start_ms: int | None,
        end_ms: int | None,
        pieces: list[str],
    ) -> list[tuple[int | None, int | None]]:
        if not pieces:
            return []
        if len(pieces) == 1:
            return [(start_ms, end_ms)]
        if start_ms is None or end_ms is None or end_ms <= start_ms:
            return [(None, None) for _ in pieces]

        total_duration = end_ms - start_ms
        weights = [max(len(re.sub(r"\s+", "", item)), 1) for item in pieces]
        total_weight = sum(weights) or len(pieces)
        cursor = start_ms
        ranges: list[tuple[int | None, int | None]] = []

        for index, weight in enumerate(weights):
            remaining_slots = len(weights) - index - 1
            if index == len(weights) - 1:
                piece_end = end_ms
            else:
                estimated = max(800, int(total_duration * (weight / total_weight)))
                max_end = end_ms - (remaining_slots * 400)
                piece_end = min(max_end, cursor + estimated)
                if piece_end <= cursor:
                    piece_end = min(end_ms, cursor + 400)
            ranges.append((cursor, piece_end))
            cursor = piece_end

        return ranges

    def _dedupe_semantic_segments(self, segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
        deduped: list[TranscriptSegment] = []
        for segment in segments:
            text = segment.text.strip()
            if not text or not self._is_meaningful_semantic_text(text):
                continue

            signature = self._build_semantic_signature(text)
            duplicate = False
            for previous in reversed(deduped[-4:]):
                previous_signature = self._build_semantic_signature(previous.text)
                time_close = (
                    segment.start_ms is None
                    or previous.start_ms is None
                    or abs(segment.start_ms - previous.start_ms) <= 15000
                )
                if not time_close:
                    continue
                if signature == previous_signature or self._semantic_text_overlaps(previous.text, text):
                    duplicate = True
                    break

            if not duplicate:
                deduped.append(segment)
        return deduped

    def _compact_semantic_segments(self, segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
        if not segments:
            return []

        compacted: list[TranscriptSegment] = []
        buffer: list[TranscriptSegment] = []
        for segment in segments:
            candidate_text = self._merge_semantic_texts([item.text for item in [*buffer, segment]])
            buffer_start = buffer[0].start_ms if buffer else segment.start_ms
            segment_end = segment.end_ms
            current_duration = 0
            if buffer_start is not None and segment_end is not None:
                current_duration = max(0, segment_end - buffer_start)
            current_text = segment.text.strip()
            previous_text = buffer[-1].text.strip() if buffer else ""

            if buffer and (
                len(candidate_text) > 128
                or current_duration > 26000
                or (len(previous_text) >= 32 and len(current_text) >= 32)
            ):
                compacted.append(self._merge_semantic_segment_group(buffer))
                buffer = [segment]
                continue

            buffer.append(segment)

        if buffer:
            compacted.append(self._merge_semantic_segment_group(buffer))
        return compacted

    def _merge_semantic_segment_group(self, segments: list[TranscriptSegment]) -> TranscriptSegment:
        first = segments[0]
        last = segments[-1]
        return TranscriptSegment(
            start_ms=first.start_ms,
            end_ms=last.end_ms,
            text=self._merge_semantic_texts([item.text for item in segments]),
            source_kind=first.source_kind,
            quality_level=first.quality_level,
        )

    def _merge_semantic_texts(self, texts: list[str]) -> str:
        merged = ""
        for item in texts:
            cleaned = item.strip()
            if not cleaned:
                continue
            merged = self._join_semantic_text(merged, cleaned)
        return merged

    def _build_description_segments(self, description: str) -> list[TranscriptSegment]:
        cleaned = description.strip()
        if not cleaned:
            return []

        sentences = [
            re.sub(r"\s+", " ", item).strip()
            for item in re.split(r"(?<=[。！？!?；;])|\n+", cleaned)
            if re.sub(r"\s+", " ", item).strip()
        ]
        if not sentences:
            sentences = [cleaned]

        chunks: list[str] = []
        buffer: list[str] = []
        for sentence in sentences:
            candidate = " ".join([*buffer, sentence]).strip()
            if buffer and len(candidate) > 96:
                chunks.append(" ".join(buffer).strip())
                buffer = [sentence]
            else:
                buffer.append(sentence)
        if buffer:
            chunks.append(" ".join(buffer).strip())

        return [
            TranscriptSegment(
                start_ms=None,
                end_ms=None,
                text=item,
                source_kind="description",
                quality_level="fallback",
            )
            for item in chunks[:6]
            if item.strip()
        ]

    def _build_synthetic_segments(
        self,
        text: str,
        *,
        duration_seconds: int | None,
        source_kind: str,
        quality_level: str,
    ) -> list[TranscriptSegment]:
        cleaned = text.strip()
        if not cleaned:
            return []

        sentences = [item.strip() for item in re.split(r"(?<=[。！？!?；;])|\n+", cleaned) if item.strip()]
        if not sentences:
            sentences = [cleaned]

        merged_segments: list[str] = []
        buffer: list[str] = []
        for sentence in sentences:
            candidate = " ".join([*buffer, sentence]).strip()
            if buffer and len(candidate) > 72:
                merged_segments.append(" ".join(buffer).strip())
                buffer = [sentence]
            else:
                buffer.append(sentence)
        if buffer:
            merged_segments.append(" ".join(buffer).strip())

        total_duration_ms = max(0, int(duration_seconds or 0) * 1000)
        total_chars = sum(max(len(item), 1) for item in merged_segments) or 1
        cursor = 0
        segments: list[TranscriptSegment] = []
        for index, item in enumerate(merged_segments):
            if total_duration_ms > 0:
                if index == len(merged_segments) - 1:
                    end_ms = total_duration_ms
                else:
                    ratio = len(item) / total_chars
                    estimated = max(6000, int(total_duration_ms * ratio))
                    end_ms = min(total_duration_ms, cursor + estimated)
                start_ms = cursor
                cursor = end_ms
            else:
                start_ms = None
                end_ms = None

            segments.append(
                TranscriptSegment(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    text=item,
                    source_kind=f"{source_kind}_estimated",
                    quality_level=quality_level,
                )
        )
        return self._compact_segments(self._dedupe_segments(segments))

    def _build_asr_segments(self, raw_segments: Any) -> list[TranscriptSegment]:
        if not isinstance(raw_segments, list):
            return []

        segments: list[TranscriptSegment] = []
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            start_ms = self._coerce_milliseconds(item.get("start_ms"))
            end_ms = self._coerce_milliseconds(item.get("end_ms"))
            segments.append(
                TranscriptSegment(
                    start_ms=start_ms,
                    end_ms=end_ms,
                    text=text,
                    source_kind="asr",
                    quality_level="high" if start_ms is not None else "estimated",
                )
            )
        return self._compact_segments(self._dedupe_segments(segments))

    def _serialize_segment(self, segment: TranscriptSegment, source_url: str | None = None) -> dict[str, Any]:
        return {
            "start_ms": segment.start_ms,
            "end_ms": segment.end_ms,
            "text": segment.text,
            "source_kind": segment.source_kind,
            "quality_level": segment.quality_level,
            "timestamp_label": self._format_segment_range(segment.start_ms, segment.end_ms),
            "seek_url": build_seek_url(source_url, segment.start_ms),
        }

    def _dedupe_segments(self, segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
        deduped: list[TranscriptSegment] = []
        seen: set[tuple[int | None, int | None, str]] = set()
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            key = (segment.start_ms, segment.end_ms, text)
            if key in seen:
                continue
            seen.add(key)
            deduped.append(segment)
        return deduped

    def _compact_segments(self, segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
        if not segments:
            return []

        compacted: list[TranscriptSegment] = []
        buffer: list[TranscriptSegment] = []
        for segment in segments:
            candidate_text = " ".join([item.text for item in [*buffer, segment]]).strip()
            buffer_start = buffer[0].start_ms if buffer else segment.start_ms
            segment_end = segment.end_ms
            current_duration = 0
            if buffer_start is not None and segment_end is not None:
                current_duration = max(0, segment_end - buffer_start)

            if buffer and (len(candidate_text) > 180 or current_duration > 40000):
                compacted.append(self._merge_segment_group(buffer))
                buffer = [segment]
                continue

            buffer.append(segment)

        if buffer:
            compacted.append(self._merge_segment_group(buffer))

        return compacted

    def _merge_segment_group(self, segments: list[TranscriptSegment]) -> TranscriptSegment:
        first = segments[0]
        last = segments[-1]
        merged_text = " ".join(item.text.strip() for item in segments if item.text.strip()).strip()
        return TranscriptSegment(
            start_ms=first.start_ms,
            end_ms=last.end_ms,
            text=merged_text,
            source_kind=first.source_kind,
            quality_level=first.quality_level,
        )

    def _build_raw_transcript_markdown(
        self,
        *,
        title: str,
        source_url: str,
        transcript_segments: list[TranscriptSegment],
        transcript_source: str,
        capture_state: dict[str, str | None],
    ) -> str:
        lines = [
            f"# {title}",
            "",
            "## 原始转写",
            "",
            f"- 链接: {source_url}",
            f"- 文本来源: {self._label_transcript_source(transcript_source)}",
            f"- 当前状态: {capture_state['label']}",
            f"- 当前说明: {capture_state['summary']}",
            "",
        ]
        if capture_state["recommended_action"]:
            lines.extend([f"- 建议下一步: {capture_state['recommended_action']}", ""])

        if not transcript_segments:
            lines.extend(["当前没有可展示的原始转写。", ""])
            return "\n".join(lines)

        for index, segment in enumerate(transcript_segments, start=1):
            timestamp_label = self._format_segment_range(segment.start_ms, segment.end_ms) or f"片段 {index}"
            lines.extend(
                [
                    f"### {timestamp_label}",
                    "",
                    segment.text,
                    "",
                ]
            )
        return "\n".join(lines)

    def _label_transcript_source(self, source: str) -> str:
        if source == "subtitle":
            return "公开字幕"
        if source == "asr":
            return "音频转写"
        if source == "description":
            return "视频简介回退"
        return "未确定来源"

    def _build_timeline_lines(self, transcript_segments: list[TranscriptSegment], *, limit: int = 4) -> list[str]:
        if not transcript_segments:
            return []

        timestamped_segments = [item for item in transcript_segments if item.start_ms is not None]
        if not timestamped_segments:
            return []

        selected_segments = self._sample_timeline_segments(timestamped_segments, limit=limit)
        lines: list[str] = []
        for segment in selected_segments:
            timestamp_label = self._format_segment_range(segment.start_ms, segment.end_ms) or self._format_timestamp(segment.start_ms)
            snippet = re.sub(r"\s+", " ", segment.text).strip()
            if len(snippet) > 56:
                snippet = snippet[:56].rstrip() + "..."
            lines.append(f"- {timestamp_label}：{snippet}")
        return lines

    def _sample_timeline_segments(self, segments: list[TranscriptSegment], *, limit: int) -> list[TranscriptSegment]:
        if len(segments) <= limit:
            return segments

        indices = {
            round(step * (len(segments) - 1) / (limit - 1))
            for step in range(limit)
        }
        return [segments[index] for index in sorted(indices)[:limit]]

    def _to_milliseconds(self, value: Any) -> int | None:
        if value is None:
            return None
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            return None
        if seconds < 0:
            return None
        return int(seconds * 1000)

    def _coerce_milliseconds(self, value: Any) -> int | None:
        if value is None:
            return None
        try:
            milliseconds = int(value)
        except (TypeError, ValueError):
            return None
        return milliseconds if milliseconds >= 0 else None

    def _format_segment_range(self, start_ms: int | None, end_ms: int | None) -> str:
        if start_ms is None and end_ms is None:
            return ""
        start_label = self._format_timestamp(start_ms)
        end_label = self._format_timestamp(end_ms)
        if start_label and end_label:
            return f"{start_label} - {end_label}"
        return start_label or end_label

    def _format_timestamp(self, value_ms: int | None) -> str:
        if value_ms is None or value_ms < 0:
            return ""
        total_seconds = int(value_ms // 1000)
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _build_capture_state(
        self,
        *,
        transcript_source: str,
        subtitle_need_login: bool,
        cookie_enabled: bool,
        cookie_stored: bool,
        cookie_active: bool,
        audio_available: bool,
        asr_configured: bool,
        asr_error: str | None,
        timestamps_available: bool,
        timestamps_estimated: bool,
    ) -> dict[str, str | None]:
        if transcript_source == "subtitle" and timestamps_available:
            return {
                "status": "ready",
                "quality": "timestamped_subtitle",
                "label": "已建立时间化正文",
                "summary": "当前已获取字幕正文，并且可以基于时间戳回看原视频。",
                "recommended_action": "可以直接验证精炼笔记、检索片段和问答回溯效果。",
                "blocked_reason": None,
            }

        if transcript_source == "asr" and timestamps_available and not timestamps_estimated:
            return {
                "status": "ready",
                "quality": "timestamped_asr",
                "label": "已恢复正文并建立时间定位",
                "summary": "当前已通过音频转写恢复正文，并且拿到了可用于回看和检索的分段时间戳。",
                "recommended_action": "建议直接验证检索片段、时间跳转和问答回溯效果。",
                "blocked_reason": None,
            }

        if transcript_source == "asr":
            return {
                "status": "ready_estimated",
                "quality": "estimated_asr",
                "label": "已恢复正文，时间戳为估算",
                "summary": "当前已通过音频转写恢复正文，可以继续做检索和问答，但时间戳仍是估算值。",
                "recommended_action": "建议重点核对关键片段；如果想提升精度，可补充 B 站登录态后重试。",
                "blocked_reason": None,
            }

        if audio_available and asr_configured and asr_error:
            return {
                "status": "asr_failed",
                "quality": "description_only",
                "label": "音频转写未成功",
                "summary": "当前没有拿到可用字幕，音频转写也没有成功返回正文，因此只保留了视频简介。",
                "recommended_action": "请检查音频转写配置、模型可用性和额度状态后，再重新解析。",
                "blocked_reason": "asr_failed",
            }

        if subtitle_need_login and not cookie_active:
            return {
                "status": "needs_cookie",
                "quality": "description_only",
                "label": "需要登录态补全字幕",
                "summary": "B 站返回了需要登录后才能访问字幕的信号，本次只保留了视频简介，尚未拿到可回溯正文。",
                "recommended_action": (
                    f"{self._build_cookie_retry_action(cookie_enabled=cookie_enabled, cookie_stored=cookie_stored, retry_label='重新解析')}"
                    " 如果该视频仍无字幕，再启用音频转写。"
                ),
                "blocked_reason": "subtitle_requires_login",
            }

        if audio_available and not asr_configured:
            return {
                "status": "needs_asr",
                "quality": "description_only",
                "label": "需要音频转写补全文字层",
                "summary": "当前视频没有拿到可直接使用的字幕，系统只保留了视频简介，尚未恢复完整正文与时间戳。",
                "recommended_action": "请在设置页配置音频转写后重新解析，以恢复正文和时间定位。",
                "blocked_reason": "asr_not_configured",
            }

        if transcript_source == "description":
            return {
                "status": "limited",
                "quality": "description_only",
                "label": "仅完成基础建档",
                "summary": "当前仅获取到视频简介，适合作为占位档案，不适合作为完整视频笔记。",
                "recommended_action": "建议优先补充 B 站登录态或音频转写，以提升正文获取成功率。",
                "blocked_reason": "description_only",
            }

        return {
            "status": "limited",
            "quality": "unavailable",
            "label": "正文暂不可用",
            "summary": "当前既没有拿到字幕，也没有恢复出可用正文，只保留了最基础的档案信息。",
            "recommended_action": "建议检查原视频可访问性、B 站登录态和音频转写配置后重试。",
            "blocked_reason": "content_unavailable",
        }

    def _build_probe_prediction(
        self,
        *,
        subtitle_count: int,
        subtitle_need_login: bool,
        cookie_enabled: bool,
        cookie_stored: bool,
        cookie_active: bool,
        audio_available: bool,
        asr_configured: bool,
    ) -> tuple[str, str, str, str]:
        if subtitle_count > 0:
            return (
                "ready",
                "timestamped_subtitle",
                "这条视频当前已经能拿到公开字幕，可以直接尝试完整导入。",
                "建议直接导入，然后重点验证精炼笔记、检索片段和时间跳转。",
            )

        if subtitle_need_login and not cookie_active:
            if audio_available and asr_configured:
                return (
                    "ready_estimated",
                    "asr_possible",
                    "这条视频的字幕层受 B 站登录态限制，但当前已经具备音频转写条件，仍然可以尝试恢复正文。",
                    (
                        "建议直接导入并重点验证转写片段、时间定位和专有名词质量；"
                        f"如果想要更稳的时间化正文，建议再{self._build_cookie_follow_up_hint(cookie_enabled=cookie_enabled, cookie_stored=cookie_stored)}。"
                    ),
                )
            return (
                "needs_cookie",
                "subtitle_requires_login",
                "这条视频的字幕层当前受 B 站登录态限制，直接导入大概率只会生成基础建档结果。",
                self._build_cookie_retry_action(
                    cookie_enabled=cookie_enabled,
                    cookie_stored=cookie_stored,
                    retry_label="重新预检或正式导入",
                ),
            )

        if audio_available and asr_configured:
            return (
                "ready_estimated",
                "asr_possible",
                "当前虽然没有直接拿到字幕，但已经具备音频转写条件，可以尝试通过 ASR 恢复正文。",
                "建议直接导入并重点验证转写片段、玩法机制和时间定位质量。",
            )

        if audio_available:
            return (
                "needs_asr",
                "audio_only",
                "当前拿不到可直接使用的字幕，但视频音频流可用，适合通过 ASR 恢复正文。",
                "建议先配置音频转写能力，再对同一条链接重新预检或正式导入。",
            )

        return (
            "limited",
            "metadata_only",
            "当前只能拿到基础元数据，直接导入大概率无法形成完整视频笔记。",
            "建议优先更换样本，或检查视频是否受平台权限限制。",
        )




