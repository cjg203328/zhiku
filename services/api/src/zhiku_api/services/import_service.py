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
        summary = self._clean_note_line(payload.get("summary"), max_length=160) or "当前正文不足，只能先保留已获取信息。"
        key_points = self._normalize_note_points(payload.get("key_points"))
        practical_lines = self._build_practical_digest_lines(payload)
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
            "",
            "## 核心结论",
            "",
            summary,
        ]

        if summary_focus.strip():
            lines[7:7] = [
                "## 本次关注",
                "",
                self._clean_note_line(summary_focus, max_length=120),
                "",
            ]

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
                "## 实用整理",
                "",
                *practical_lines,
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
        summary = self._clean_note_line(payload.get("summary"), max_length=160) or "当前正文不足，只能先保留已获取信息。"
        key_points = self._normalize_note_points(payload.get("key_points"))
        practical_lines = self._build_practical_digest_lines(payload)
        origin_lines = self._build_origin_digest_lines(payload, metadata, include_host=True)

        lines = [
            "## 网页速览",
            "",
            f"- 来源站点：{host}",
            f"- 内容来源：{self._clean_note_line(metadata.get('content_source') or '网页正文抽取', max_length=48)}",
            "",
            "## 核心结论",
            "",
            summary,
        ]

        if summary_focus.strip():
            lines[5:5] = [
                "## 本次关注",
                "",
                self._clean_note_line(summary_focus, max_length=120),
                "",
            ]

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
                "## 实用整理",
                "",
                *practical_lines,
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
        summary = self._clean_note_line(payload.get("summary"), max_length=160) or "当前正文不足，只能先保留已获取信息。"
        key_points = self._normalize_note_points(payload.get("key_points"))
        practical_lines = self._build_practical_digest_lines(payload)
        action_lines = self._build_action_lines(payload, metadata, summary_focus=summary_focus)
        origin_lines = self._build_origin_digest_lines(payload, metadata, include_host=True)

        summary_title = "核心结论"
        points_title = "内容结构"
        useful_title = "对用户有用的信息"
        action_title = "可执行建议"
        if note_style == "qa":
            summary_title = "问题结论"
            points_title = "关键答案"
            useful_title = "可直接参考的信息"
            action_title = "下一步建议"
        elif note_style == "brief":
            summary_title = "快速摘要"
            points_title = "重点列表"
            useful_title = "简版整理"
            action_title = "下一步建议"

        lines = [
            f"## {summary_title}",
            "",
            summary,
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
                *practical_lines,
            ])

        if action_lines:
            lines.extend([
                "",
                f"## {action_title}",
                "",
                *action_lines,
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
            text = self._clean_note_line(item.get("text"), max_length=88)
            if not text or self._is_low_signal_note_line(text):
                continue
            label = self._format_note_timestamp(item.get("start_ms")) or f"片段 {index}"
            lines.append(f"- {label}：{text}")
        return lines

    def _build_clip_digest_sections(self, metadata: dict[str, Any], *, limit: int = 4) -> list[str]:
        segments = self._sample_note_segments(metadata, limit=limit)
        lines: list[str] = []
        for index, item in enumerate(segments, start=1):
            text = self._clean_note_line(item.get("text"), max_length=140)
            if not text or self._is_low_signal_note_line(text):
                continue
            label = self._format_note_timestamp(item.get("start_ms")) or f"片段 {index}"
            lines.extend([f"### {label}", "", text, ""])
        return lines

    def _build_practical_digest_lines(self, payload: dict[str, Any], *, limit: int = 3) -> list[str]:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        candidates: list[str] = []

        for item in self._sample_note_segments(metadata, limit=limit):
            text = self._clean_note_line(item.get("text"), max_length=140)
            if text and not self._is_low_signal_note_line(text):
                candidates.append(text)

        if not candidates:
            content_text = str(payload.get("content_text") or "").strip()
            raw_parts = re.split(r"\n{2,}|\r?\n|(?<=[。！？!?])\s+", content_text)
            for part in raw_parts:
                text = self._clean_note_line(part, max_length=140)
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

    def _build_action_lines(self, payload: dict[str, Any], metadata: dict[str, Any], *, summary_focus: str) -> list[str]:
        status = str(payload.get("status") or "").strip().lower()
        needs_guidance = status in {"ready_estimated", "needs_cookie", "needs_asr", "asr_failed", "limited"}
        if metadata.get("noisy_asr_detected") is True:
            needs_guidance = True
        if not needs_guidance:
            return []

        candidates = [
            f"优先围绕“{self._clean_note_line(summary_focus, max_length=48)}”继续核对关键片段。"
            if summary_focus.strip()
            else "",
            self._clean_note_line(metadata.get("quality_recommended_action"), max_length=88),
            self._clean_note_line(metadata.get("capture_recommended_action"), max_length=88),
        ]
        if metadata.get("noisy_asr_detected") is True:
            candidates.append("当前正文主要来自音频转写，重要结论建议结合证据层逐段核对。")

        lines: list[str] = []
        seen: set[str] = set()
        for item in candidates:
            text = self._clean_note_line(item, max_length=96)
            if self._is_low_signal_note_line(text):
                continue
            normalized = re.sub(r"\s+", "", text.lower())
            if not text or normalized in seen:
                continue
            seen.add(normalized)
            lines.append(f"- {text}")
        return lines[:3]

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

        capture_summary = self._clean_note_line(metadata.get("capture_summary"), max_length=88)
        if capture_summary:
            lines.append(f"- 当前说明：{capture_summary}")

        return lines[:4]

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
            "笔记风格",
            "播放",
            "点赞",
            "链接",
        )
        points: list[str] = []
        seen: set[str] = set()
        for item in value:
            text = self._clean_note_line(item, max_length=88)
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
        )
        if any(text.startswith(prefix) for prefix in low_signal_prefixes):
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

        return False

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
