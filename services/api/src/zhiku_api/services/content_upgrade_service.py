from __future__ import annotations

from typing import Any

from ..config import AppSettings
from .import_service import ImportService


class ContentUpgradeService:
    def __init__(self, settings: AppSettings | None = None) -> None:
        self.settings = settings
        self.import_service = ImportService(settings)

    def upgrade_contents(
        self,
        repository: Any,
        *,
        platform: str | None = None,
        limit: int = 20,
        force: bool = False,
        retry_incomplete: bool = True,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        duplicate_cleanup = repository.cleanup_duplicate_contents(dry_run=dry_run)
        duplicates_archived = int(duplicate_cleanup.get("duplicates_archived") or 0)
        duplicate_groups = int(duplicate_cleanup.get("duplicate_groups") or 0)

        listing = repository.list_contents()
        rows = listing.get("items") if isinstance(listing, dict) else []
        if not isinstance(rows, list):
            rows = []

        platform_filter = str(platform or "").strip().lower()
        scanned = 0
        targeted = 0
        upgraded = 0
        repaired = 0
        reimported = 0
        fallback_repaired = 0
        skipped = 0
        failed = 0
        results: list[dict[str, Any]] = []

        for row in rows:
            content_id = str((row or {}).get("id") or "").strip()
            if not content_id:
                continue

            row_platform = str((row or {}).get("platform") or "").strip().lower()
            if platform_filter and row_platform != platform_filter:
                continue

            scanned += 1
            content = repository.get_content(content_id)
            if content is None:
                skipped += 1
                continue

            plan = self._plan_upgrade(content, force=force, retry_incomplete=retry_incomplete)
            if not plan["needs_upgrade"]:
                skipped += 1
                continue

            targeted += 1
            title = str(content.get("title") or "").strip() or "未命名内容"
            if dry_run:
                results.append(
                    {
                        "content_id": content_id,
                        "title": title,
                        "action": "planned",
                        "reasons": plan["reasons"],
                        "message": "已纳入本次升级计划",
                    }
                )
            else:
                try:
                    refreshed, action, message = self._upgrade_single(content, use_reimport=plan["use_reimport"])
                    stored = repository.replace_content(content_id, content=refreshed)
                    if stored is None:
                        raise RuntimeError("内容在升级过程中已不存在")

                    upgraded += 1
                    if action == "reimported":
                        reimported += 1
                    elif action == "repaired_after_reimport_failure":
                        fallback_repaired += 1
                    else:
                        repaired += 1

                    results.append(
                        {
                            "content_id": content_id,
                            "title": title,
                            "action": action,
                            "reasons": plan["reasons"],
                            "message": message,
                        }
                    )
                except Exception as exc:
                    failed += 1
                    results.append(
                        {
                            "content_id": content_id,
                            "title": title,
                            "action": "failed",
                            "reasons": plan["reasons"],
                            "message": str(exc),
                        }
                    )

            if targeted >= limit:
                break

        return {
            "ok": True,
            "summary": {
                "platform": platform_filter or None,
                "scanned": scanned,
                "targeted": targeted,
                "upgraded": upgraded,
                "repaired": repaired,
                "reimported": reimported,
                "fallback_repaired": fallback_repaired,
                "skipped": skipped,
                "failed": failed,
                "duplicate_groups": duplicate_groups,
                "duplicates_archived": duplicates_archived,
                "dry_run": dry_run,
                "limit": limit,
            },
            "items": results,
            "message": self._build_summary_message(
                dry_run=dry_run,
                targeted=targeted,
                upgraded=upgraded,
                repaired=repaired,
                reimported=reimported,
                fallback_repaired=fallback_repaired,
                failed=failed,
                duplicate_groups=duplicate_groups,
                duplicates_archived=duplicates_archived,
            ),
        }

    def _upgrade_single(self, content: dict[str, Any], *, use_reimport: bool) -> tuple[dict[str, Any], str, str]:
        if use_reimport:
            try:
                refreshed = self._reimport_content(content)
                return refreshed, "reimported", "已基于原始来源重新抓取并覆盖更新"
            except Exception as exc:
                repaired = self.import_service.upgrade_existing_content(content)
                return repaired, "repaired_after_reimport_failure", f"源重试失败，已回退为本地修复：{exc}"

        repaired = self.import_service.upgrade_existing_content(content)
        return repaired, "repaired", "已基于现有内容补齐元数据和质量标记"

    def _reimport_content(self, content: dict[str, Any]) -> dict[str, Any]:
        source_url = str(content.get("source_url") or "").strip()
        source_file = str(content.get("source_file") or content.get("local_path") or "").strip()
        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        note_style = str(metadata.get("note_style") or "structured")
        summary_focus = str(metadata.get("summary_focus") or "")

        if source_url:
            return self.import_service.import_url(
                source_url,
                note_style=note_style,
                summary_focus=summary_focus,
            )
        if source_file:
            return self.import_service.build_file_preview(
                source_file,
                note_style=note_style,
                summary_focus=summary_focus,
            )
        raise ValueError("这条内容没有可用于重新抓取的原始来源")

    def _plan_upgrade(self, content: dict[str, Any], *, force: bool, retry_incomplete: bool) -> dict[str, Any]:
        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        reasons: list[str] = []

        if force:
            reasons.append("force_refresh")
        else:
            if self._content_terms_missing(metadata):
                reasons.append("content_terms_missing")
            if self._note_quality_missing(metadata):
                reasons.append("note_quality_missing")
            if self._semantic_transcript_missing(content, metadata):
                reasons.append("semantic_transcript_missing")
            if self._quality_shortcuts_missing(metadata):
                reasons.append("quality_shortcuts_missing")
            if self._seek_urls_missing(metadata):
                reasons.append("seek_urls_missing")
            if self._llm_enhancement_missing(content, metadata):
                reasons.append("llm_note_missing")

        use_reimport = False
        if retry_incomplete and self._has_reimport_source(content) and self._capture_retry_worthwhile(content):
            reasons.append("retry_incomplete_capture")
            use_reimport = True

        return {
            "needs_upgrade": bool(reasons),
            "use_reimport": use_reimport,
            "reasons": reasons,
        }

    def _content_terms_missing(self, metadata: dict[str, Any]) -> bool:
        content_terms = metadata.get("content_terms")
        if not isinstance(content_terms, dict):
            return True
        primary_terms = content_terms.get("primary_terms")
        topic_query = str(content_terms.get("topic_query") or "").strip()
        return not isinstance(primary_terms, list) or (not primary_terms and not topic_query)

    def _note_quality_missing(self, metadata: dict[str, Any]) -> bool:
        note_quality = metadata.get("note_quality")
        if not isinstance(note_quality, dict):
            return True
        return "score" not in note_quality or "level" not in note_quality

    def _semantic_transcript_missing(self, content: dict[str, Any], metadata: dict[str, Any]) -> bool:
        raw_segments = metadata.get("transcript_segments")
        if not isinstance(raw_segments, list):
            return False

        has_raw_segments = any(isinstance(item, dict) and str(item.get("text") or "").strip() for item in raw_segments)
        if not has_raw_segments:
            return False

        semantic_segments = metadata.get("semantic_transcript_segments")
        has_semantic_segments = isinstance(semantic_segments, list) and any(
            isinstance(item, dict) and str(item.get("text") or "").strip() for item in semantic_segments
        )
        semantic_ready = bool(metadata.get("semantic_transcript_ready"))
        semantic_content_text = str(metadata.get("semantic_content_text") or "").strip()

        if not has_semantic_segments or not semantic_ready or not semantic_content_text:
            return True

        platform = str(content.get("platform") or "").strip().lower()
        content_type = str(content.get("content_type") or "").strip().lower()
        content_text = str(content.get("content_text") or "").strip()
        if (platform == "bilibili" or content_type == "video") and not content_text:
            return True
        return False

    def _quality_shortcuts_missing(self, metadata: dict[str, Any]) -> bool:
        required_keys = (
            "quality_score",
            "quality_level",
            "quality_label",
            "quality_summary",
            "quality_recommended_action",
            "double_note_ready",
            "time_jump_ready",
            "retrieval_ready",
            "question_answer_ready",
            "semantic_score",
            "agent_ready",
            "llm_enhanced",
        )
        return any(key not in metadata for key in required_keys)

    def _llm_enhancement_missing(self, content: dict[str, Any], metadata: dict[str, Any]) -> bool:
        if self.settings is None or not bool(getattr(self.settings, "llm_enabled", False)):
            return False
        if metadata.get("llm_enhanced") is True:
            return False

        source_type = str(content.get("source_type") or "").strip().lower()
        status = str(content.get("status") or metadata.get("capture_status") or "").strip().lower()
        content_text = str(content.get("content_text") or "").strip()
        summary = str(content.get("summary") or "").strip()

        if source_type == "chat_note":
            return False
        if status in {"preview_ready", "needs_cookie", "needs_asr", "asr_failed"}:
            return False
        return len(content_text) >= 180 or len(summary) >= 60

    def _seek_urls_missing(self, metadata: dict[str, Any]) -> bool:
        raw_segments = metadata.get("transcript_segments")
        if not isinstance(raw_segments, list):
            return False

        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            if item.get("start_ms") is None:
                continue
            seek_url = str(item.get("seek_url") or "").strip()
            if not seek_url:
                return True
        return False

    def _capture_retry_worthwhile(self, content: dict[str, Any]) -> bool:
        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        status = str(content.get("status") or metadata.get("capture_status") or "").strip()
        return status in {"needs_cookie", "needs_asr", "asr_failed", "limited"}

    def _has_reimport_source(self, content: dict[str, Any]) -> bool:
        source_url = str(content.get("source_url") or "").strip()
        source_file = str(content.get("source_file") or content.get("local_path") or "").strip()
        return bool(source_url or source_file)

    def _build_summary_message(
        self,
        *,
        dry_run: bool,
        targeted: int,
        upgraded: int,
        repaired: int,
        reimported: int,
        fallback_repaired: int,
        failed: int,
        duplicate_groups: int,
        duplicates_archived: int,
    ) -> str:
        if dry_run:
            if duplicate_groups > 0:
                return f"本次识别出 {targeted} 条可升级内容，并发现 {duplicate_groups} 组同源重复项。"
            return f"本次共识别出 {targeted} 条可升级内容。"
        if targeted == 0:
            if duplicates_archived > 0:
                return f"当前没有发现需要升级的旧内容，但已整理 {duplicate_groups} 组同源重复项，并回收到回收站 {duplicates_archived} 条。"
            return "当前没有发现需要升级的旧内容。"

        parts = [f"本次已处理 {upgraded} 条旧内容"]
        if repaired:
            parts.append(f"其中本地修复 {repaired} 条")
        if reimported:
            parts.append(f"重新抓取 {reimported} 条")
        if fallback_repaired:
            parts.append(f"重抓失败后回退本地修复 {fallback_repaired} 条")
        if failed:
            parts.append(f"失败 {failed} 条")
        if duplicates_archived:
            parts.append(f"并将 {duplicate_groups} 组同源重复项共 {duplicates_archived} 条移入回收站")
        return "；".join(parts) + "。"
