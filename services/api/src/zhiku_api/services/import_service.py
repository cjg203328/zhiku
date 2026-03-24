from __future__ import annotations

import base64
from copy import deepcopy
from enum import Enum
from pathlib import Path
import tempfile
from urllib.parse import urlparse
import re
from typing import Any, Callable
from uuid import uuid4

from .bilibili_service import BilibiliParseError, BilibiliService, TranscriptSegment
from .bilibili_session_broker import BilibiliSessionBroker
from .content_link_service import build_seek_url
from .content_term_service import ContentTermService
from .file_parse_service import FileParseService
from .initial_material_service import InitialMaterialService
from .llm_gateway import LlmGateway
from .note_quality_service import NoteQualityService
from .webpage_service import WebpageParseError, WebpageService


class ImportErrorCode(str, Enum):
    NETWORK_TIMEOUT = "network_timeout"        # 网络超时
    SUBTITLE_UNAVAILABLE = "subtitle_unavailable"  # 字幕/转写不可用
    LLM_RATE_LIMIT = "llm_rate_limit"          # LLM 限速
    LLM_UNAVAILABLE = "llm_unavailable"        # LLM 连接失败
    DISK_FULL = "disk_full"                    # 磁盘空间不足
    AUTH_REQUIRED = "auth_required"            # 需要登录态 (Cookie)
    PARSE_FAILED = "parse_failed"              # 内容解析失败
    UNKNOWN = "unknown"                        # 未归类异常


def _classify_error(exc: BaseException) -> ImportErrorCode:
    # 优先按异常类型分类
    import urllib.error
    if isinstance(exc, TimeoutError) or isinstance(exc, urllib.error.URLError) and "timed out" in str(exc).lower():
        return ImportErrorCode.NETWORK_TIMEOUT
    if isinstance(exc, OSError) and any(k in str(exc).lower() for k in ("no space", "disk full", "enospc", "磁盘")):
        return ImportErrorCode.DISK_FULL

    # 再按消息关键字兜底（避免宽泛词误匹配）
    msg = str(exc).lower()
    if any(k in msg for k in ("timeout", "timed out", "connection reset", "read timeout")):
        return ImportErrorCode.NETWORK_TIMEOUT
    if any(k in msg for k in ("cookie", "login", "403", "unauthorized", "need login")):
        return ImportErrorCode.AUTH_REQUIRED
    if any(k in msg for k in ("subtitle", "subtitles", "caption", "transcript", "asr", "字幕", "转写")):
        return ImportErrorCode.SUBTITLE_UNAVAILABLE
    if any(k in msg for k in ("rate limit", "429", "too many requests", "quota exceeded")):
        return ImportErrorCode.LLM_RATE_LIMIT
    if any(k in msg for k in ("connection refused", "llm unavailable", "model not found", "no models")):
        return ImportErrorCode.LLM_UNAVAILABLE
    if any(k in msg for k in ("no space", "disk full", "enospc", "磁盘")):
        return ImportErrorCode.DISK_FULL
    return ImportErrorCode.UNKNOWN


BILIBILI_PATTERNS = (
    re.compile(r"https?://(?:www\.)?bilibili\.com/video/(BV[0-9A-Za-z]+)", re.IGNORECASE),
    re.compile(r"https?://b23\.tv/[0-9A-Za-z]+", re.IGNORECASE),
    re.compile(r"^(BV[0-9A-Za-z]+)$", re.IGNORECASE),
)


class ImportService:
    def __init__(
        self,
        settings: Any | None = None,
        *,
        bilibili_session_broker: BilibiliSessionBroker | None = None,
    ) -> None:
        self.settings = settings
        self.file_parse_service = FileParseService()
        self.bilibili_service = BilibiliService(
            settings=settings,
            bilibili_session_broker=bilibili_session_broker,
        )
        self.webpage_service = WebpageService(settings=settings)
        self.llm_gateway = LlmGateway(settings) if settings is not None else None
        self.content_term_service = ContentTermService()
        self.initial_material_service = InitialMaterialService()
        self.note_quality_service = NoteQualityService()

    def import_url(
        self,
        url: str,
        *,
        note_style: str = "structured",
        summary_focus: str = "",
        progress_callback: Callable[[str, int, str | None, dict[str, Any] | None], None] | None = None,
    ) -> dict:
        platform = self._detect_platform(url)
        if platform == "bilibili":
            try:
                parsed = self.bilibili_service.parse(
                    url,
                    note_style=note_style,
                    summary_focus=summary_focus,
                    progress_callback=progress_callback,
                )
                return self._attach_import_metadata(parsed, import_mode="parsed", note_style=note_style, summary_focus=summary_focus)
            except BilibiliParseError as exc:
                preview = self.build_url_preview(url)
                error_code = _classify_error(exc)
                preview["summary"] = f"B站详细解析暂不可用，已先保存链接：{exc}"
                preview["key_points"] = [
                    "已识别为 B站链接",
                    f"当前原因：{exc}",
                    "已先保存到知识库，后续可重试解析或手动补充内容",
                ]
                preview["metadata"]["import_mode"] = "fallback_preview"
                preview["metadata"]["parse_error"] = str(exc)
                preview["metadata"]["error_code"] = error_code.value
                preview["metadata"]["note_style"] = note_style
                preview["metadata"]["summary_focus"] = summary_focus
                return self._attach_import_metadata(
                    preview,
                    import_mode="fallback_preview",
                    note_style=note_style,
                    summary_focus=summary_focus,
                )
            except Exception as exc:
                preview = self.build_url_preview(url)
                error_code = _classify_error(exc)
                preview["summary"] = "B站解析过程中遇到异常，已先保存链接预览。"
                preview["key_points"] = [
                    "已识别为 B站链接",
                    "当前解析链路出现未预期异常",
                    "已回退为链接预览，避免页面直接报错",
                ]
                preview["metadata"]["import_mode"] = "fallback_preview"
                preview["metadata"]["parse_error"] = str(exc)
                preview["metadata"]["error_code"] = error_code.value
                preview["metadata"]["note_style"] = note_style
                preview["metadata"]["summary_focus"] = summary_focus
                return self._attach_import_metadata(
                    preview,
                    import_mode="fallback_preview",
                    note_style=note_style,
                    summary_focus=summary_focus,
                )
        if platform == "webpage":
            try:
                parsed = self.webpage_service.parse(url, note_style=note_style, summary_focus=summary_focus)
                return self._attach_import_metadata(parsed, import_mode="parsed", note_style=note_style, summary_focus=summary_focus)
            except WebpageParseError as exc:
                preview = self.build_url_preview(url)
                error_code = _classify_error(exc)
                preview["summary"] = f"网页正文抽取暂不可用，已先保存链接：{exc}"
                preview["key_points"] = [
                    "已识别为网页或文章链接",
                    f"当前原因：{exc}",
                    "已先保存链接预览，后续可重试解析或手动补充内容",
                ]
                preview["metadata"]["import_mode"] = "fallback_preview"
                preview["metadata"]["parse_error"] = str(exc)
                preview["metadata"]["error_code"] = error_code.value
                preview["metadata"]["note_style"] = note_style
                preview["metadata"]["summary_focus"] = summary_focus
                preview["metadata"]["content_source"] = "unavailable"
                return self._attach_import_metadata(
                    preview,
                    import_mode="fallback_preview",
                    note_style=note_style,
                    summary_focus=summary_focus,
                )
            except Exception as exc:
                preview = self.build_url_preview(url)
                error_code = _classify_error(exc)
                preview["summary"] = "网页解析过程中遇到异常，已先保存链接预览。"
                preview["key_points"] = [
                    "已识别为网页或文章链接",
                    "当前解析链路出现未预期异常",
                    "已回退为链接预览，避免页面直接报错",
                ]
                preview["metadata"]["import_mode"] = "fallback_preview"
                preview["metadata"]["parse_error"] = str(exc)
                preview["metadata"]["error_code"] = error_code.value
                preview["metadata"]["note_style"] = note_style
                preview["metadata"]["summary_focus"] = summary_focus
                preview["metadata"]["content_source"] = "unavailable"
                return self._attach_import_metadata(
                    preview,
                    import_mode="fallback_preview",
                    note_style=note_style,
                    summary_focus=summary_focus,
                )
        preview = self.build_url_preview(url)
        return self._attach_import_metadata(preview, import_mode="preview", note_style=note_style, summary_focus=summary_focus)

    def build_pending_preview(
        self,
        source_value: str,
        *,
        source_kind: str,
        note_style: str = "structured",
        summary_focus: str = "",
    ) -> dict[str, Any]:
        is_file_source = source_kind in {"file", "file_upload"}
        platform = self._detect_platform(source_value)
        source_name = Path(source_value).name if is_file_source else source_value.strip()
        title_hint = source_name or ("导入任务" if is_file_source else "链接任务")

        return {
            "source_type": "file" if is_file_source else "url",
            "platform": platform,
            "source_url": None if is_file_source else source_value,
            "source_file": source_value if is_file_source else None,
            "title": f"正在导入：{title_hint}",
            "author": None,
            "content_text": "",
            "summary": "任务已排队，正在提取正文与整理笔记。",
            "key_points": [
                "已接收导入任务",
                "系统正在解析原始内容",
                "完成后会自动生成可问答笔记",
            ],
            "quotes": [],
            "category": "待整理",
            "content_type": "pending_import",
            "use_case": "导入中",
            "tags": ["导入中", platform],
            "metadata": {
                "import_mode": "queued",
                "note_style": note_style,
                "summary_focus": summary_focus,
                "content_source": "pending",
                "job_source_kind": source_kind,
            },
            "local_path": source_value if is_file_source else None,
            "status": "import_pending",
        }

    def build_url_preview(self, url: str) -> dict:
        platform = self._detect_platform(url)
        parsed = urlparse(url if url.startswith("http") else f"https://{url}")
        title_hint = parsed.path.strip("/") or parsed.netloc or url
        return {
            "source_type": "url",
            "platform": platform,
            "source_url": url,
            "title": f"链接导入：{title_hint}",
            "author": None,
            "content_text": f"已接收链接：{url}\n当前为首版工程链路，下一步在此接入 {platform} 的真实解析。",
            "summary": f"已创建 {platform} 链接导入任务，当前返回预览数据。",
            "key_points": [
                "已识别为链接导入任务",
                f"平台识别结果：{platform}",
                "后续将在此接入真实内容抓取与清洗流程",
            ],
            "quotes": [],
            "category": "链接收藏",
            "content_type": "url",
            "use_case": "参考",
            "tags": ["链接", platform],
            "metadata": {
                "host": parsed.netloc,
                "path": parsed.path,
                "content_source": "preview_only",
            },
            "local_path": None,
            "status": "preview_ready",
        }

    def build_file_preview(self, file_path: str, *, note_style: str = "structured", summary_focus: str = "") -> dict:
        preview = self.file_parse_service.extract(file_path)
        return self._attach_import_metadata(
            preview,
            import_mode="parsed",
            note_style=note_style,
            summary_focus=summary_focus,
        )

    def build_uploaded_file_preview(
        self,
        filename: str,
        content_base64: str,
        *,
        note_style: str = "structured",
        summary_focus: str = "",
    ) -> dict:
        if not filename.strip():
            raise ValueError("文件名不能为空")

        try:
            payload = base64.b64decode(content_base64, validate=True)
        except Exception as exc:
            raise ValueError("上传文件内容不是有效的 Base64 数据") from exc

        safe_name = Path(filename).name or f"upload-{uuid4().hex}"
        suffix = Path(safe_name).suffix or ".bin"
        temp_dir = self._resolve_upload_temp_dir()
        temp_dir.mkdir(parents=True, exist_ok=True)

        temp_path = temp_dir / f"upload-{uuid4().hex}{suffix}"
        temp_path.write_bytes(payload)
        preview = self.file_parse_service.extract(str(temp_path), original_name=safe_name)
        return self._attach_import_metadata(
            preview,
            import_mode="parsed",
            note_style=note_style,
            summary_focus=summary_focus,
        )

    def upgrade_existing_content(self, payload: dict[str, Any]) -> dict[str, Any]:
        upgraded = deepcopy(payload)
        metadata = upgraded.get("metadata") if isinstance(upgraded.get("metadata"), dict) else {}
        upgraded["metadata"] = metadata

        normalized_segments = self._normalize_transcript_segments(
            metadata.get("transcript_segments"),
            source_url=upgraded.get("source_url"),
            transcript_source=metadata.get("transcript_source"),
            timestamps_estimated=bool(metadata.get("timestamps_estimated")),
        )
        if normalized_segments:
            metadata["transcript_segments"] = normalized_segments
            metadata["timestamps_available"] = any(item.get("start_ms") is not None for item in normalized_segments)
            raw_content_text = "\n".join(
                str(item.get("text") or "").strip() for item in normalized_segments if str(item.get("text") or "").strip()
            ).strip()
            if raw_content_text:
                metadata["raw_content_text"] = raw_content_text

        normalized_semantic_segments = self._normalize_transcript_segments(
            metadata.get("semantic_transcript_segments"),
            source_url=upgraded.get("source_url"),
            transcript_source=metadata.get("transcript_source"),
            timestamps_estimated=bool(metadata.get("timestamps_estimated")),
        )
        if not normalized_semantic_segments and normalized_segments:
            normalized_semantic_segments = self._derive_semantic_transcript_segments(
                normalized_segments,
                source_url=upgraded.get("source_url"),
                transcript_source=metadata.get("transcript_source"),
                timestamps_estimated=bool(metadata.get("timestamps_estimated")),
            )
        if normalized_semantic_segments:
            metadata["semantic_transcript_segments"] = normalized_semantic_segments
            metadata["semantic_transcript_ready"] = True
            semantic_content_text = "\n".join(
                str(item.get("text") or "").strip() for item in normalized_semantic_segments if str(item.get("text") or "").strip()
            ).strip()
            metadata["semantic_content_text"] = semantic_content_text
            if semantic_content_text and self._should_promote_semantic_content(upgraded):
                upgraded["content_text"] = semantic_content_text

        import_mode = str(metadata.get("import_mode") or "upgraded")
        note_style = str(metadata.get("note_style") or "structured")
        summary_focus = str(metadata.get("summary_focus") or "")
        return self._attach_import_metadata(
            upgraded,
            import_mode=import_mode,
            note_style=note_style,
            summary_focus=summary_focus,
        )

    def _detect_platform(self, value: str) -> str:
        lowered = value.lower()
        if any(pattern.search(value) for pattern in BILIBILI_PATTERNS) or "bilibili.com" in lowered or "b23.tv" in lowered:
            return "bilibili"
        if Path(value).suffix:
            return "local_file"
        return "webpage"

    def _resolve_upload_temp_dir(self) -> Path:
        if self.settings is not None:
            temp_dir = getattr(self.settings, "knowledge_base_dir", None)
            if temp_dir is not None:
                return Path(temp_dir) / "temp" / "uploads"

        return Path(tempfile.gettempdir()) / "Zhiku" / "uploads"

    def _attach_import_metadata(
        self,
        payload: dict[str, Any],
        *,
        import_mode: str,
        note_style: str,
        summary_focus: str,
    ) -> dict[str, Any]:
        payload.setdefault("metadata", {})
        payload["metadata"]["import_mode"] = import_mode
        payload["metadata"]["note_style"] = note_style
        payload["metadata"]["summary_focus"] = summary_focus
        self.initial_material_service.prepare(payload)
        self._apply_llm_note_enhancement(
            payload,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        self._refresh_refined_note_markdown(
            payload,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        payload["metadata"]["content_terms"] = self.content_term_service.extract(payload)
        quality = self.note_quality_service.evaluate(payload)
        payload["metadata"]["note_quality"] = quality
        payload["metadata"]["quality_score"] = quality["score"]
        payload["metadata"]["quality_level"] = quality["level"]
        payload["metadata"]["quality_label"] = quality["label"]
        payload["metadata"]["quality_summary"] = quality["summary"]
        payload["metadata"]["quality_recommended_action"] = quality["recommended_action"]
        payload["metadata"]["double_note_ready"] = quality["double_note_ready"]
        payload["metadata"]["time_jump_ready"] = quality["time_jump_ready"]
        payload["metadata"]["retrieval_ready"] = quality["retrieval_ready"]
        payload["metadata"]["question_answer_ready"] = quality["question_answer_ready"]
        payload["metadata"]["semantic_score"] = quality["semantic_score"]
        payload["metadata"]["agent_ready"] = quality["agent_ready"]
        payload["metadata"]["llm_enhanced"] = quality["llm_enhanced"]
        return payload

    def _apply_llm_note_enhancement(
        self,
        payload: dict[str, Any],
        *,
        note_style: str,
        summary_focus: str,
    ) -> None:
        if self.llm_gateway is None or not self.llm_gateway.is_enabled():
            return

        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        if metadata.get("llm_enhanced") is True:
            return

        source_type = str(payload.get("source_type") or "").strip().lower()
        status = str(payload.get("status") or metadata.get("capture_status") or "").strip().lower()
        content_text = str(payload.get("content_text") or "").strip()
        summary = str(payload.get("summary") or "").strip()

        if source_type == "chat_note":
            return
        if status in {"preview_ready", "needs_cookie", "needs_asr", "asr_failed"}:
            return
        if len(content_text) < 180 and len(summary) < 60:
            return

        source_reference = (
            str(payload.get("source_url") or "").strip()
            or str(payload.get("source_file") or "").strip()
            or str(payload.get("local_path") or "").strip()
            or "-"
        )
        enhanced = self.llm_gateway.enhance_import_result(
            title=str(payload.get("title") or "未命名内容").strip() or "未命名内容",
            author=str(payload.get("author") or "").strip() or None,
            source_url=source_reference,
            content_text=content_text,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        if enhanced is None:
            return

        payload["summary"] = enhanced.get("summary") or payload.get("summary") or ""
        payload["key_points"] = enhanced.get("key_points") or payload.get("key_points") or []
        note_markdown = str(enhanced.get("note_markdown") or "").strip()
        if note_markdown:
            if metadata.get("note_markdown") and metadata.get("note_markdown") != note_markdown:
                metadata["baseline_note_markdown"] = metadata.get("note_markdown")
            metadata["note_markdown"] = note_markdown
            metadata["refined_note_markdown"] = note_markdown
        metadata["llm_enhanced"] = True
        metadata["llm_enhanced_source"] = "import_service"
        payload["metadata"] = metadata

    def _refresh_refined_note_markdown(
        self,
        payload: dict[str, Any],
        *,
        note_style: str,
        summary_focus: str,
    ) -> None:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        payload["metadata"] = metadata

        clean_note = self._build_refined_note_markdown(
            payload,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        if not clean_note:
            return

        existing_note = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
        if existing_note and existing_note != clean_note and not metadata.get("baseline_note_markdown"):
            metadata["baseline_note_markdown"] = existing_note
        metadata["note_markdown"] = clean_note
        metadata["refined_note_markdown"] = clean_note

    def _build_refined_note_markdown(
        self,
        payload: dict[str, Any],
        *,
        note_style: str,
        summary_focus: str,
    ) -> str:
        platform = str(payload.get("platform") or "").strip().lower()
        if note_style == "bilinote" and platform == "bilibili":
            return self._build_bilibili_reading_note(payload, summary_focus=summary_focus)
        if note_style == "bilinote" and platform == "webpage":
            return self._build_webpage_reading_note(payload, summary_focus=summary_focus)
        return self._build_compact_note(payload, note_style=note_style, summary_focus=summary_focus)

    def _build_bilibili_reading_note(self, payload: dict[str, Any], *, summary_focus: str) -> str:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        author = self._clean_note_line(payload.get("author"), max_length=48) or "-"
        duration = payload.get("duration") or metadata.get("duration")
        duration_text = f"{duration} 秒" if str(duration or "").strip() else "未知"
        transcript_source = self._describe_transcript_source(metadata.get("transcript_source"))
        timeline_label = self._describe_timeline_state(metadata)
        practical_lines = self._build_practical_digest_lines(payload, limit=4)
        summary_paragraphs = self._build_summary_paragraphs(payload, metadata, practical_lines)
        key_points = self._remove_redundant_note_points(self._normalize_note_points(payload.get("key_points")), practical_lines)
        timeline_lines = self._build_timeline_digest_lines(metadata)
        clip_sections = self._build_clip_digest_sections(metadata)
        origin_lines = self._build_origin_digest_lines(payload, metadata, include_host=False)

        lines = [
            "## 视频速览",
            "",
            f"- 作者：{author}",
            f"- 时长：{duration_text}",
            f"- 正文来源：{transcript_source}",
            f"- 时间定位：{timeline_label}",
        ]

        if summary_focus.strip():
            lines.extend([
                "",
                "## 本次关注",
                "",
                self._polish_note_prose(summary_focus, max_length=120, ensure_terminal=False),
                "",
            ])

        lines.extend([
            "",
            "## 核心结论",
            "",
            *self._render_note_paragraphs(summary_paragraphs),
        ])

        if key_points:
            lines.extend([
                "",
                "## 值得记住的内容",
                "",
                *[f"- {item}" for item in key_points],
            ])

        if timeline_lines:
            lines.extend([
                "",
                "## 时间线笔记",
                "",
                *timeline_lines,
            ])

        if clip_sections:
            lines.extend([
                "",
                "## 片段整理",
                "",
                *clip_sections,
            ])

        if practical_lines:
            lines.extend([
                "",
                "## 精炼正文",
                "",
                *self._render_note_paragraphs(practical_lines),
            ])

        if origin_lines:
            lines.extend([
                "",
                "## 原始信息保留",
                "",
                *origin_lines,
            ])
        return self._join_note_lines(lines)

    def _build_webpage_reading_note(self, payload: dict[str, Any], *, summary_focus: str) -> str:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        host = self._clean_note_line(urlparse(str(payload.get("source_url") or "")).netloc.replace("www.", ""), max_length=48) or "网页来源"
        practical_lines = self._build_practical_digest_lines(payload, limit=4)
        summary_paragraphs = self._build_summary_paragraphs(payload, metadata, practical_lines)
        key_points = self._remove_redundant_note_points(self._normalize_note_points(payload.get("key_points")), practical_lines)
        origin_lines = self._build_origin_digest_lines(payload, metadata, include_host=True)

        lines = [
            "## 网页速览",
            "",
            f"- 来源站点：{host}",
            f"- 内容来源：{self._clean_note_line(metadata.get('content_source') or '网页正文抽取', max_length=48)}",
        ]

        if summary_focus.strip():
            lines.extend([
                "",
                "## 本次关注",
                "",
                self._polish_note_prose(summary_focus, max_length=120, ensure_terminal=False),
                "",
            ])

        lines.extend([
            "",
            "## 核心结论",
            "",
            *self._render_note_paragraphs(summary_paragraphs),
        ])

        if key_points:
            lines.extend([
                "",
                "## 值得记住的内容",
                "",
                *[f"- {item}" for item in key_points],
            ])

        if practical_lines:
            lines.extend([
                "",
                "## 精炼正文",
                "",
                *self._render_note_paragraphs(practical_lines),
            ])

        if origin_lines:
            lines.extend([
                "",
                "## 原始信息保留",
                "",
                *origin_lines,
            ])
        return self._join_note_lines(lines)

    def _build_compact_note(
        self,
        payload: dict[str, Any],
        *,
        note_style: str,
        summary_focus: str,
    ) -> str:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        practical_lines = self._build_practical_digest_lines(payload, limit=4)
        summary_paragraphs = self._build_summary_paragraphs(payload, metadata, practical_lines)
        key_points = self._remove_redundant_note_points(self._normalize_note_points(payload.get("key_points")), practical_lines)
        origin_lines = self._build_origin_digest_lines(payload, metadata, include_host=True)

        summary_title = "核心结论"
        points_title = "重点摘录"
        useful_title = "精炼正文"
        if note_style == "qa":
            summary_title = "问题结论"
            points_title = "关键答案"
            useful_title = "回答整理"
        elif note_style == "brief":
            summary_title = "快速摘要"
            points_title = "重点摘录"
            useful_title = "精炼正文"

        lines = [
            f"## {summary_title}",
            "",
            *self._render_note_paragraphs(summary_paragraphs),
        ]

        if key_points:
            lines.extend([
                "",
                f"## {points_title}",
                "",
                *[f"- {item}" for item in key_points],
            ])

        if practical_lines:
            lines.extend([
                "",
                f"## {useful_title}",
                "",
                *self._render_note_paragraphs(practical_lines),
            ])

        if origin_lines:
            lines.extend([
                "",
                "## 原始信息保留",
                "",
                *origin_lines,
            ])
        return self._join_note_lines(lines)

    def _build_timeline_digest_lines(self, metadata: dict[str, Any], *, limit: int = 6) -> list[str]:
        segments = self._sample_note_segments(metadata, limit=limit)
        lines: list[str] = []
        for index, item in enumerate(segments, start=1):
            text = self._polish_note_prose(item.get("text"), max_length=88)
            if not text or self._is_low_signal_note_line(text):
                continue
            label = self._format_note_timestamp(item.get("start_ms")) or f"片段 {index}"
            lines.append(f"- {label}：{text}")
        return lines

    def _build_clip_digest_sections(self, metadata: dict[str, Any], *, limit: int = 4) -> list[str]:
        segments = self._sample_note_segments(metadata, limit=limit)
        lines: list[str] = []
        for index, item in enumerate(segments, start=1):
            text = self._polish_note_prose(item.get("text"), max_length=140)
            if not text or self._is_low_signal_note_line(text):
                continue
            label = self._format_note_timestamp(item.get("start_ms")) or f"片段 {index}"
            lines.extend([f"### {label}", "", text, ""])
        return lines

    def _build_practical_digest_lines(self, payload: dict[str, Any], *, limit: int = 4) -> list[str]:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        candidates = self._build_coherent_note_paragraphs(payload, metadata, limit=limit)

        if not candidates:
            content_text = str(payload.get("content_text") or "").strip()
            raw_parts = self._split_note_source_parts(content_text)
            for part in raw_parts:
                text = self._polish_note_prose(part, max_length=180)
                if text and not self._is_low_signal_note_line(text):
                    candidates.append(text)
                if len(candidates) >= limit:
                    break

        deduped: list[str] = []
        seen: set[str] = set()
        for item in candidates:
            normalized = re.sub(r"\s+", "", item.lower())
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            deduped.append(item)
        return deduped[:limit]

    def _build_summary_paragraphs(
        self,
        payload: dict[str, Any],
        metadata: dict[str, Any],
        practical_lines: list[str],
    ) -> list[str]:
        summary_paragraphs = self._filter_note_paragraphs(
            self._build_note_paragraphs(
                payload.get("summary"),
                max_length=160,
                fallback="当前正文不足，只能先保留已获取信息。",
            )
        )
        if not practical_lines:
            return summary_paragraphs

        if not summary_paragraphs:
            return practical_lines[:1]

        first_paragraph = summary_paragraphs[0]
        if self._looks_like_intro_note_line(first_paragraph):
            return practical_lines[:1]

        # noisy ASR 经常把开场口癖或断裂句子抬成摘要，优先改用正文首段承接
        if metadata.get("noisy_asr_detected") is True and metadata.get("llm_enhanced") is not True:
            return practical_lines[:1]

        return summary_paragraphs

    def _build_coherent_note_paragraphs(
        self,
        payload: dict[str, Any],
        metadata: dict[str, Any],
        *,
        limit: int,
    ) -> list[str]:
        raw_segments = metadata.get("semantic_transcript_segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            raw_segments = metadata.get("transcript_segments")

        ordered_segments: list[str] = []
        if isinstance(raw_segments, list):
            for item in raw_segments:
                if not isinstance(item, dict):
                    continue
                text = self._polish_note_prose(item.get("text"), max_length=180, ensure_terminal=False)
                if not text or self._is_low_signal_note_line(text):
                    continue
                ordered_segments.append(text)

        if not ordered_segments:
            content_text = str(payload.get("content_text") or "").strip()
            ordered_segments = [
                self._polish_note_prose(part, max_length=180, ensure_terminal=False)
                for part in self._split_note_source_parts(content_text)
            ]
            ordered_segments = [item for item in ordered_segments if item and not self._is_low_signal_note_line(item)]

        ordered_segments = self._rewrite_introductory_note_lines(ordered_segments)
        ordered_segments = self._trim_introductory_note_lines(ordered_segments)
        if not ordered_segments:
            return []

        paragraphs: list[str] = []
        buffer = ""
        buffer_items = 0
        for item in ordered_segments:
            merged = self._merge_note_paragraph_text(buffer, item)
            if buffer and (buffer_items >= 3 or len(merged) > 188):
                if len(merged) <= 228 and self._should_join_note_directly(buffer, item):
                    buffer = merged
                    buffer_items += 1
                    continue
                finalized = self._polish_note_prose(buffer, max_length=220)
                if finalized and not self._is_low_signal_note_line(finalized):
                    paragraphs.append(finalized)
                buffer = item
                buffer_items = 1
            else:
                buffer = merged
                buffer_items = buffer_items + 1 if buffer_items else 1

            if len(paragraphs) >= limit:
                break

        if buffer and len(paragraphs) < limit:
            finalized = self._polish_note_prose(buffer, max_length=220)
            if finalized and not self._is_low_signal_note_line(finalized):
                paragraphs.append(finalized)

        return paragraphs[:limit]

    def _split_note_source_parts(self, text: str) -> list[str]:
        if not text.strip():
            return []

        parts = [
            part.strip()
            for part in re.split(r"\n{2,}|\r?\n|(?<=[。！？；!?])\s+|(?<=[，；,;])\s{2,}", text)
            if part.strip()
        ]
        if parts:
            return parts
        return [text.strip()]

    def _trim_introductory_note_lines(self, items: list[str]) -> list[str]:
        trimmed = list(items)
        while len(trimmed) > 1 and self._looks_like_intro_note_line(trimmed[0]):
            trimmed.pop(0)
        return trimmed or items

    def _rewrite_introductory_note_lines(self, items: list[str]) -> list[str]:
        rewritten = list(items)
        for index in range(min(4, len(rewritten))):
            candidate = self._strip_introductory_note_prefix(rewritten[index])
            if candidate:
                rewritten[index] = candidate
        return rewritten

    def _strip_introductory_note_prefix(self, text: str) -> str:
        source = (text or "").strip()
        if not source:
            return ""

        informative_patterns = (
            r"(?:王者荣耀世界|这款游戏|这个游戏|本作|该作)(?:可|会|是|支持|里|的)",
            r"(?:可战斗|可探索|可联机|可连机|可单机|玩法|系统|机制|模式|配置|价格|角色|副本|任务|技能|装备|养成|剧情|社交|家园|PC端|手机端)",
            r"(?:首先|其次|最后|另外|同时|接下来|其实|比如|例如).{0,20}(?:玩法|系统|机制|模式|配置|角色|副本|任务|技能|装备|养成)",
            r"(?:\d{1,2}月\d{1,2}号|PC端|手机端)",
        )
        match_positions = [
            match.start()
            for pattern in informative_patterns
            for match in [re.search(pattern, source, re.IGNORECASE)]
            if match is not None
        ]
        if not match_positions:
            return source

        start_index = min(match_positions)
        if start_index <= 0:
            return source

        prefix = source[:start_index].strip()
        if not prefix:
            return source
        if not self._looks_like_intro_note_line(prefix) and not self._looks_like_intro_note_line(source):
            return source

        candidate = self._polish_note_prose(source[start_index:], max_length=180, ensure_terminal=False)
        if not candidate or len(candidate) < 18 or self._is_low_signal_note_line(candidate):
            return source
        return candidate

    def _looks_like_intro_note_line(self, text: str) -> bool:
        normalized = re.sub(r"\s+", "", text or "").lower()
        if not normalized:
            return False

        intro_patterns = (
            r"^(?:hello|hi|哈喽|嗨)?(?:大家好|各位好)",
            r"^(?:hello|hi|哈喽|嗨)",
            r"^(?:我是|这里是|欢迎来到|欢迎回到)",
            r"^(?:这期视频|本期视频|今天我们聊|今天来聊|今天想讲|今天给大家|先给大家|这次给大家)",
        )
        if any(re.search(pattern, normalized) for pattern in intro_patterns):
            return True

        chatty_markers = (
            "大家好",
            "各位",
            "兄弟们",
            "家人们",
            "朋友们",
            "老铁们",
            "欢迎来到",
            "欢迎回到",
            "我是",
            "谢谢",
            "拜托",
            "给大家做一个",
            "给大家讲",
            "给大家聊",
            "坐好发车",
            "发车",
            "先说",
            "先看",
            "接下来我们",
            "我们看到的是",
            "全网最",
            "你就说",
            "大不大吧",
            "不想玩",
        )
        informative_markers = (
            "玩法",
            "系统",
            "模式",
            "机制",
            "功能",
            "配置",
            "测试",
            "版本",
            "价格",
            "步骤",
            "方法",
            "区别",
            "原因",
            "角色",
            "副本",
            "任务",
            "技能",
            "装备",
            "社交",
            "连机",
            "联机",
            "单机",
            "战斗",
            "探索",
            "养成",
            "核心",
            "重点",
        )
        chatty_hits = sum(marker in normalized for marker in chatty_markers)
        informative_hits = sum(marker in normalized for marker in informative_markers)
        if chatty_hits >= 2 and informative_hits == 0:
            return True
        if chatty_hits >= 3 and informative_hits <= 1 and len(normalized) <= 96:
            return True
        if chatty_hits >= 4 and chatty_hits >= informative_hits + 2 and len(normalized) <= 140:
            return True

        return len(normalized) <= 36 and any(token in normalized for token in ("大家好", "我是", "欢迎来到"))

    def _merge_note_paragraph_text(self, left: str, right: str) -> str:
        if not left:
            return right.strip()
        if not right:
            return left.strip()

        stripped_left = left.rstrip()
        stripped_right = right.lstrip()
        trimmed_join_left = stripped_left.rstrip("，、,；;：:")
        if trimmed_join_left != stripped_left and self._should_join_note_directly(trimmed_join_left, stripped_right):
            return f"{trimmed_join_left}{stripped_right}"
        if stripped_left.endswith(("，", "。", "！", "？", "；", "：", "、", ",", ";", ":", "/", "-")):
            return f"{stripped_left}{stripped_right}"
        if re.search(r"[A-Za-z0-9]$", stripped_left) and re.match(r"^[A-Za-z0-9]", stripped_right):
            return f"{stripped_left} {stripped_right}"
        if re.search(r"[\u4e00-\u9fffA-Za-z0-9]$", stripped_left) and re.match(r"^[\u4e00-\u9fffA-Za-z0-9]", stripped_right):
            if self._should_join_note_directly(stripped_left, stripped_right):
                return f"{stripped_left}{stripped_right}"
            joiner = "。" if len(stripped_left) >= 96 else "，"
            return f"{stripped_left}{joiner}{stripped_right}"
        return f"{stripped_left} {stripped_right}"

    def _should_join_note_directly(self, left: str, right: str) -> bool:
        if not left or not right:
            return False

        if self._starts_with_note_sentence_connector(right):
            return False

        tail_match = re.search(r"([A-Za-z0-9\u4e00-\u9fff]{1,4})$", left)
        if not tail_match:
            return False

        tail = tail_match.group(1)
        if re.match(r"^[\u4e00-\u9fff]", right) and len(tail) <= 3:
            return True

        bridge_tails = ("的", "了", "和", "与", "及", "并", "且", "让", "把", "将", "向", "对", "给", "被", "从", "在", "于")
        return tail in bridge_tails

    def _starts_with_note_sentence_connector(self, text: str) -> bool:
        normalized = re.sub(r"\s+", "", text or "")
        if not normalized:
            return False
        connectors = (
            "那么",
            "然后",
            "但是",
            "不过",
            "所以",
            "因此",
            "当然",
            "另外",
            "同时",
            "接下来",
            "其实",
            "比如",
            "例如",
            "首先",
            "其次",
            "最后",
            "其中",
            "尤其",
        )
        return normalized.startswith(connectors)

    def _build_origin_digest_lines(
        self,
        payload: dict[str, Any],
        metadata: dict[str, Any],
        *,
        include_host: bool,
    ) -> list[str]:
        lines: list[str] = []
        if include_host:
            source_url = str(payload.get("source_url") or "").strip()
            host = self._clean_note_line(urlparse(source_url).netloc.replace("www.", ""), max_length=48)
            if host:
                lines.append(f"- 来源站点：{host}")

        transcript_source = self._describe_transcript_source(metadata.get("transcript_source"))
        if transcript_source and transcript_source != "原始正文":
            lines.append(f"- 正文来源：{transcript_source}")

        timeline_label = self._describe_timeline_state(metadata)
        if timeline_label and timeline_label != "未建立时间定位":
            lines.append(f"- 时间定位：{timeline_label}")

        return lines[:4]

    def _filter_note_paragraphs(self, paragraphs: list[str]) -> list[str]:
        filtered: list[str] = []
        seen: set[str] = set()
        for item in paragraphs:
            text = self._polish_note_prose(item, max_length=180)
            if not text or self._is_low_signal_note_line(text):
                continue
            normalized = re.sub(r"\s+", "", text.lower())
            if normalized in seen:
                continue
            seen.add(normalized)
            filtered.append(text)
        return filtered

    def _remove_redundant_note_points(self, points: list[str], paragraphs: list[str], *, limit: int = 4) -> list[str]:
        paragraph_signatures = [re.sub(r"\s+", "", item.lower()) for item in paragraphs if item]
        filtered: list[str] = []
        seen: set[str] = set()
        for item in points:
            normalized = re.sub(r"\s+", "", item.lower())
            if not normalized or normalized in seen:
                continue
            if any(
                normalized in paragraph_signature or paragraph_signature in normalized
                for paragraph_signature in paragraph_signatures
                if len(normalized) >= 12 and len(paragraph_signature) >= 12
            ):
                continue
            seen.add(normalized)
            filtered.append(item)
            if len(filtered) >= limit:
                break
        return filtered

    def _sample_note_segments(self, metadata: dict[str, Any], *, limit: int) -> list[dict[str, Any]]:
        raw_segments = metadata.get("semantic_transcript_segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            raw_segments = metadata.get("transcript_segments")
        if not isinstance(raw_segments, list) or not raw_segments:
            return []

        usable = [
            item
            for item in raw_segments
            if (
                isinstance(item, dict)
                and self._clean_note_line(item.get("text"), max_length=220)
                and not self._is_low_signal_note_line(self._clean_note_line(item.get("text"), max_length=220))
            )
        ]
        if len(usable) <= limit:
            return usable

        selected: list[dict[str, Any]] = []
        last_index = len(usable) - 1
        for slot in range(limit):
            index = round(slot * last_index / max(limit - 1, 1))
            candidate = usable[index]
            if candidate not in selected:
                selected.append(candidate)
        return selected[:limit]

    def _normalize_note_points(self, value: Any, *, limit: int = 5) -> list[str]:
        if not isinstance(value, list):
            return []

        skip_prefixes = (
            "当前状态",
            "建议下一步",
            "后续优先",
            "当前说明",
            "材料状态",
            "当前材料状态",
            "笔记风格",
            "播放",
            "点赞",
            "链接",
        )
        points: list[str] = []
        seen: set[str] = set()
        for item in value:
            text = self._polish_note_prose(item, max_length=88)
            if not text:
                continue
            if self._is_low_signal_note_line(text):
                continue
            if any(text.startswith(prefix) for prefix in skip_prefixes):
                continue
            normalized = re.sub(r"\s+", "", text.lower())
            if normalized in seen:
                continue
            seen.add(normalized)
            points.append(text)
            if len(points) >= limit:
                break
        return points

    def _describe_transcript_source(self, value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if normalized == "subtitle":
            return "字幕正文"
        if normalized.startswith("asr"):
            return "音频转写"
        if normalized == "description":
            return "简介补全"
        return "原始正文"

    def _describe_timeline_state(self, metadata: dict[str, Any]) -> str:
        if metadata.get("timestamps_estimated"):
            return "已建立估算时间定位"
        if metadata.get("timestamps_available"):
            return "已建立时间定位"
        return "未建立时间定位"

    def _format_note_timestamp(self, value: Any) -> str:
        try:
            milliseconds = int(value)
        except (TypeError, ValueError):
            return ""
        if milliseconds < 0:
            milliseconds = 0
        total_seconds = milliseconds // 1000
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _build_note_paragraphs(
        self,
        value: Any,
        *,
        max_length: int | None = None,
        fallback: str = "",
        max_sentences: int = 2,
        max_chars: int = 88,
    ) -> list[str]:
        text = self._polish_note_prose(value, max_length=max_length)
        if not text and fallback:
            text = self._polish_note_prose(fallback)
        if not text:
            return []

        sentences = self._split_note_sentences(text)
        if len(sentences) <= 1:
            return [text]

        paragraphs: list[str] = []
        current: list[str] = []
        current_length = 0
        for sentence in sentences:
            sentence_length = len(sentence)
            if current and (len(current) >= max_sentences or current_length + sentence_length > max_chars):
                paragraphs.append("".join(current))
                current = [sentence]
                current_length = sentence_length
                continue
            current.append(sentence)
            current_length += sentence_length

        if current:
            paragraphs.append("".join(current))
        return paragraphs or [text]

    def _render_note_paragraphs(self, paragraphs: list[str]) -> list[str]:
        lines: list[str] = []
        for index, paragraph in enumerate(paragraphs):
            if not paragraph:
                continue
            if index > 0:
                lines.append("")
            lines.append(paragraph)
        return lines

    def _split_note_sentences(self, text: str) -> list[str]:
        parts = re.split(r"(?<=[。！？；!?])\s*", text)
        return [part.strip() for part in parts if part.strip()]

    def _polish_note_prose(
        self,
        value: Any,
        *,
        max_length: int | None = None,
        ensure_terminal: bool = True,
    ) -> str:
        cleaned = self._clean_note_line(value, max_length=max_length)
        if not cleaned:
            return ""

        if re.search(r"[\u4e00-\u9fff]", cleaned):
            cleaned = cleaned.replace(",", "，")
            cleaned = cleaned.replace(";", "；")
            cleaned = cleaned.replace("?", "？")
            cleaned = cleaned.replace("!", "！")
            cleaned = re.sub(r"(?<=[\u4e00-\u9fff]):(?=[\u4e00-\u9fffA-Za-z0-9])", "：", cleaned)

        cleaned = re.sub(r"\s*([，。！？；：])\s*", r"\1", cleaned)
        cleaned = re.sub(r"([，。！？；：…])\1+", r"\1", cleaned)
        cleaned = cleaned.strip()
        if ensure_terminal and cleaned and not cleaned.endswith(("...", "…")) and cleaned[-1] not in "。！？；":
            cleaned += "。"
        return cleaned

    def _clean_note_line(self, value: Any, *, max_length: int | None = None) -> str:
        cleaned = str(value or "")
        if not cleaned.strip():
            return ""
        cleaned = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", r"\1", cleaned)
        cleaned = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", cleaned)
        cleaned = re.sub(r"https?://127\.0\.0\.1:\d+/static/[^\s)]+", "", cleaned)
        cleaned = re.sub(r"https?://[^\s)]+", "", cleaned)
        cleaned = re.sub(r"\*?Screenshot-(?:\[\d{2}:\d{2}(?::\d{2})?\]|\d{2}:\d{2}(?::\d{2})?)", "", cleaned)
        cleaned = cleaned.replace("BiliNote 风格笔记", "")
        cleaned = cleaned.replace("BiliNote", "")
        cleaned = cleaned.replace("**", "")
        cleaned = cleaned.replace("__", "")
        cleaned = cleaned.replace("`", "")
        cleaned = re.sub(r"\bBV[0-9A-Za-z]+\b", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\bav\d+\b", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"^#{1,6}\s*", "", cleaned)
        cleaned = re.sub(r"^\s*>\s*", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip(" -|：:")
        if max_length is not None and len(cleaned) > max_length:
            cleaned = cleaned[:max_length].rstrip() + "..."
        return cleaned

    def _is_low_signal_note_line(self, text: str) -> bool:
        if not text.strip():
            return True

        low_signal_prefixes = (
            "当前正文还不够稳定",
            "当前正文不足",
            "当前仅保留了基础",
            "当前只保留了基础",
            "当前只保留了较弱材料",
            "当前还没有提炼出稳定要点",
            "当前没有提炼出稳定要点",
            "这条视频还没有拿到可直接使用的正文",
            "内容仍需继续补齐",
            "后续优先",
            "建议下一步",
            "当前说明",
            "材料状态",
            "当前材料状态",
            "已先整理出主题线索",
            "温馨提示",
            "友情提醒",
        )
        if any(text.startswith(prefix) for prefix in low_signal_prefixes):
            return True

        low_signal_fragments = (
            "已通过音频转写恢复正文并保留可回看片段",
            "围绕具体片段继续提问和核对原视频",
            "围绕时间片段继续提问并核对原视频",
            "接入理解模型重整精炼层",
        )
        if any(fragment in text for fragment in low_signal_fragments):
            return True

        if re.search(r"(?:播放|点赞|投币|收藏|转发)\s*[：:]\s*\d+", text):
            return True

        if re.search(r"\b(?:BV[0-9A-Za-z]+|av\d+)\b", text, flags=re.IGNORECASE):
            return True

        if re.match(r"^(?:打开原视频|原视频链接|源视频链接)", text):
            return True

        if re.search(r"^(?:粉丝|关注(?:数)?|弹幕(?:数)?|收藏(?:数)?|播放量|发布时间|上传时间)[：:]\s*\S+", text):
            return True

        if re.search(r"space\.bilibili\.com", text):
            return True

        if self._looks_like_promotional_note_line(text):
            return True

        return False

    def _looks_like_promotional_note_line(self, text: str) -> bool:
        normalized = re.sub(r"\s+", "", text or "").lower()
        if not normalized:
            return False

        promo_patterns = (
            r"(?:点击|记得|欢迎|麻烦|帮忙).{0,8}(?:关注|点赞|收藏|投币|三连)",
            r"(?:评论区|置顶|下方|下边|简介区|简介里).{0,12}(?:链接|领取|查看|获取|报名|课程|资料|福利)",
            r"(?:直播|训练营|社群|粉丝群|知识星球|公众号|私信|加微|微信|vx|qq群|群聊)",
            r"(?:课程介绍|介绍一下.{0,8}课程|报名|优惠|折扣|福利|下单|购买|咨询|预约|体验课|陪跑)",
            r"(?:课程中相见|课程里见|训练营里见|直播间见|下节课见|我们课上见|拜拜)$",
        )
        if any(re.search(pattern, normalized) for pattern in promo_patterns):
            return True

        cta_hits = sum(
            token in normalized
            for token in ("关注", "点赞", "收藏", "投币", "三连", "评论区", "置顶", "下方", "链接", "私信")
        )
        if cta_hits >= 2:
            return True

        has_sales_topic = any(token in normalized for token in ("课程", "训练营", "社群", "报名", "优惠", "福利"))
        has_sales_action = any(token in normalized for token in ("链接", "评论区", "置顶", "领取", "咨询", "购买", "下单"))
        return has_sales_topic and has_sales_action

    def _join_note_lines(self, lines: list[str]) -> str:
        merged = "\n".join(lines)
        merged = re.sub(r"\n{3,}", "\n\n", merged)
        return merged.strip()

    def _derive_semantic_transcript_segments(
        self,
        raw_segments: list[dict[str, Any]],
        *,
        source_url: str | None,
        transcript_source: Any,
        timestamps_estimated: bool,
    ) -> list[dict[str, Any]]:
        source_kind = self._resolve_source_kind(transcript_source, timestamps_estimated=timestamps_estimated)
        normalized_source = str(transcript_source or "").strip() or (
            "asr" if source_kind.startswith("asr") else "description" if source_kind == "description" else "subtitle"
        )

        transcript_segments: list[TranscriptSegment] = []
        for item in raw_segments:
            if not isinstance(item, dict):
                continue

            text = str(item.get("text") or "").strip()
            if not text:
                continue

            transcript_segments.append(
                TranscriptSegment(
                    start_ms=self._coerce_milliseconds(item.get("start_ms")),
                    end_ms=self._coerce_milliseconds(item.get("end_ms")),
                    text=text,
                    source_kind=str(item.get("source_kind") or source_kind).strip() or source_kind,
                    quality_level=str(item.get("quality_level") or "unknown").strip() or "unknown",
                )
            )

        if not transcript_segments:
            return []

        derived_segments = self.bilibili_service._build_semantic_transcript_segments(
            transcript_segments,
            transcript_source=normalized_source,
        )
        return [self.bilibili_service._serialize_segment(item, source_url) for item in derived_segments]

    def _should_promote_semantic_content(self, payload: dict[str, Any]) -> bool:
        platform = str(payload.get("platform") or "").strip().lower()
        content_type = str(payload.get("content_type") or "").strip().lower()
        return platform == "bilibili" or content_type == "video"

    def _normalize_transcript_segments(
        self,
        raw_segments: Any,
        *,
        source_url: str | None,
        transcript_source: Any,
        timestamps_estimated: bool,
    ) -> list[dict[str, Any]]:
        if not isinstance(raw_segments, list):
            return []

        normalized: list[dict[str, Any]] = []
        fallback_source_kind = self._resolve_source_kind(transcript_source, timestamps_estimated=timestamps_estimated)
        for item in raw_segments:
            if not isinstance(item, dict):
                continue

            text = str(item.get("text") or "").strip()
            if not text:
                continue

            start_ms = self._coerce_milliseconds(item.get("start_ms"))
            end_ms = self._coerce_milliseconds(item.get("end_ms"))
            source_kind = str(item.get("source_kind") or fallback_source_kind).strip() or fallback_source_kind
            quality_level = str(
                item.get("quality_level") or ("estimated" if timestamps_estimated or start_ms is None else "high")
            ).strip() or ("estimated" if timestamps_estimated or start_ms is None else "high")

            segment = dict(item)
            segment["text"] = text
            segment["start_ms"] = start_ms
            segment["end_ms"] = end_ms
            segment["source_kind"] = source_kind
            segment["quality_level"] = quality_level
            segment["timestamp_label"] = str(item.get("timestamp_label") or "").strip() or self._format_segment_range(start_ms, end_ms)
            segment["seek_url"] = str(item.get("seek_url") or "").strip() or build_seek_url(source_url, start_ms)
            normalized.append(segment)

        return normalized

    def _resolve_source_kind(self, transcript_source: Any, *, timestamps_estimated: bool) -> str:
        normalized = str(transcript_source or "").strip()
        if normalized == "subtitle":
            return "subtitle"
        if normalized == "description":
            return "description"
        if normalized == "asr":
            return "asr_estimated" if timestamps_estimated else "asr"
        return "transcript"

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
        if value_ms is None:
            return ""
        total_seconds = int(value_ms // 1000)
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"
