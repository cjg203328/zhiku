from __future__ import annotations

import re
from typing import Any


WEAK_CAPTURE_STATUSES = {"needs_cookie", "needs_asr", "asr_failed", "limited", "preview_ready"}


class InitialMaterialService:
    def prepare(self, payload: dict[str, Any]) -> None:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        capture_status = str(payload.get("status") or metadata.get("capture_status") or "").strip().lower()
        summary = str(payload.get("summary") or "").strip()
        content_text = str(payload.get("content_text") or "").strip()
        title = str(payload.get("title") or "").strip() or "未命名内容"
        author = str(payload.get("author") or "").strip()
        platform = str(payload.get("platform") or "").strip()
        tags = [str(item).strip() for item in (payload.get("tags") or []) if str(item).strip()]

        description = self._clean_source_text(str(metadata.get("source_description") or "").strip())
        capture_summary = str(metadata.get("capture_summary") or "").strip()
        capture_action = str(metadata.get("capture_recommended_action") or "").strip()
        transcript_source = str(metadata.get("transcript_source") or "").strip() or "unknown"

        seed_points = self._build_seed_points(
            title=title,
            description=description,
            summary=summary,
            capture_summary=capture_summary,
            capture_action=capture_action,
        )
        seed_queries = self._build_seed_queries(title=title, tags=tags, seed_points=seed_points)
        seed_markdown = self._build_seed_markdown(
            title=title,
            author=author,
            platform=platform,
            transcript_source=transcript_source,
            capture_summary=capture_summary,
            capture_action=capture_action,
            seed_points=seed_points,
            seed_queries=seed_queries,
        )
        seed_text = self._build_seed_text(
            title=title,
            author=author,
            platform=platform,
            transcript_source=transcript_source,
            capture_summary=capture_summary,
            capture_action=capture_action,
            seed_points=seed_points,
        )

        metadata["material_seed_ready"] = bool(seed_points)
        metadata["material_seed_points"] = seed_points
        metadata["material_seed_queries"] = seed_queries
        metadata["material_seed_markdown"] = seed_markdown
        metadata["material_seed_summary"] = self._build_seed_summary(title=title, capture_summary=capture_summary, seed_points=seed_points)
        metadata["material_seed_level"] = "weak_capture" if capture_status in WEAK_CAPTURE_STATUSES else "baseline"
        payload["metadata"] = metadata

        if capture_status not in WEAK_CAPTURE_STATUSES:
          return

        if seed_text and len(seed_text) > len(content_text):
            payload["content_text"] = seed_text

        if seed_points:
            payload["key_points"] = seed_points[:4]

        payload["summary"] = self._build_seed_summary(
            title=title,
            capture_summary=capture_summary or summary,
            seed_points=seed_points,
        )

    def _build_seed_summary(self, *, title: str, capture_summary: str, seed_points: list[str]) -> str:
        lead = capture_summary.strip() or f"《{title}》当前只拿到了有限材料。"
        if seed_points:
            return f"{lead} 已先整理出主题线索：{seed_points[0]}"
        return lead

    def _build_seed_points(
        self,
        *,
        title: str,
        description: str,
        summary: str,
        capture_summary: str,
        capture_action: str,
    ) -> list[str]:
        points: list[str] = []
        if title.strip():
            points.append(f"主题焦点：{title.strip()}")

        source_text = "\n".join(
            item for item in [description, summary, capture_summary] if item.strip()
        ).strip()
        candidates = self._extract_candidate_sentences(source_text)
        for item in candidates:
            if item not in points:
                points.append(item)
            if len(points) >= 3:
                break

        if capture_action.strip():
            points.append(f"后续优先：{capture_action.strip()}")

        deduped: list[str] = []
        for item in points:
            cleaned = self._normalize_point(item)
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:4]

    def _build_seed_queries(self, *, title: str, tags: list[str], seed_points: list[str]) -> list[str]:
        topic = tags[0] if tags else title[:12]
        queries = [
            f"{title} 主要观点是什么？",
            f"{topic} 这条内容里最值得核对的结论是什么？",
        ]
        if seed_points:
            first_point = re.sub(r"^(主题焦点：|后续优先：)", "", seed_points[0]).strip()
            if first_point:
                queries.append(f"围绕“{first_point}”还能继续追问什么？")

        deduped: list[str] = []
        for item in queries:
            cleaned = re.sub(r"\s+", " ", item).strip()
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:3]

    def _build_seed_markdown(
        self,
        *,
        title: str,
        author: str,
        platform: str,
        transcript_source: str,
        capture_summary: str,
        capture_action: str,
        seed_points: list[str],
        seed_queries: list[str],
    ) -> str:
        lines = [
            f"# {title}",
            "",
            "## 初步材料整理",
            "",
            f"- 平台: {platform or '-'}",
            f"- 作者: {author or '-'}",
            f"- 当前正文来源: {transcript_source or '-'}",
            f"- 当前材料状态: {capture_summary or '仅拿到有限线索'}",
        ]
        if capture_action:
            lines.append(f"- 建议下一步: {capture_action}")
        lines.append("")
        lines.append("## 当前可用线索")
        lines.append("")
        if seed_points:
            lines.extend([f"- {item}" for item in seed_points])
        else:
            lines.append("- 当前还没有足够线索形成初步整理。")
        if seed_queries:
            lines.extend(["", "## 适合继续追问", ""])
            lines.extend([f"- {item}" for item in seed_queries])
        return "\n".join(lines).strip()

    def _build_seed_text(
        self,
        *,
        title: str,
        author: str,
        platform: str,
        transcript_source: str,
        capture_summary: str,
        capture_action: str,
        seed_points: list[str],
    ) -> str:
        lines = [
            f"主题：{title}",
            f"平台：{platform or '-'}",
            f"作者：{author or '-'}",
            f"当前正文来源：{transcript_source or '-'}",
            f"材料状态：{capture_summary or '仅拿到有限线索'}",
        ]
        if seed_points:
            lines.append("当前可用线索：")
            lines.extend([f"- {item}" for item in seed_points])
        if capture_action:
            lines.append(f"建议下一步：{capture_action}")
        return "\n".join(lines).strip()

    def _extract_candidate_sentences(self, text: str) -> list[str]:
        if not text.strip():
            return []

        items = [
            self._clean_source_text(item)
            for item in re.split(r"[\n。！？!?；;]", text)
        ]
        scored: list[tuple[int, str]] = []
        for item in items:
            if len(item) < 10:
                continue
            score = min(len(item), 42)
            if 16 <= len(item) <= 68:
                score += 10
            if re.search(r"\d", item):
                score += 4
            if any(token in item for token in ("核心", "关键", "问题", "行业", "策略", "AI", "独立游戏", "3A", "建议", "趋势")):
                score += 8
            if any(token in item for token in ("http", "BV", "点击", "合作", "商务", "链接", "关注", "转发")):
                score -= 16
            if item.endswith(("吗", "呢", "？", "?")):
                score -= 4
            scored.append((score, item))

        ordered = sorted(scored, key=lambda row: (-row[0], row[1]))
        picked: list[str] = []
        for _, item in ordered:
            if any(item in existing or existing in item for existing in picked):
                continue
            picked.append(item)
            if len(picked) >= 3:
                break
        return picked

    def _clean_source_text(self, text: str) -> str:
        cleaned = re.sub(r"https?://\S+", " ", text or "")
        cleaned = re.sub(r"BV[0-9A-Za-z]+", " ", cleaned)
        cleaned = re.sub(r"[#@]", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned

    def _normalize_point(self, text: str) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip(" -:：;；，,。")
        if len(cleaned) < 6:
            return ""
        return cleaned
