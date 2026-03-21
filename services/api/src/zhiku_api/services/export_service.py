from __future__ import annotations

from pathlib import Path
import re


class ExportService:
    def __init__(self, export_dir: Path) -> None:
        self.export_dir = export_dir

    def export_content_markdown(self, content: dict, *, include_annotations: bool = False) -> Path:
        self.export_dir.mkdir(parents=True, exist_ok=True)

        safe_title = self._slugify(content.get("title") or content.get("id") or "content")
        suffix = "_annotated" if include_annotations else ""
        target_path = self.export_dir / f"{safe_title}{suffix}.md"

        metadata = content.get("metadata") or {}
        refined_note = None
        raw_transcript = None
        if isinstance(metadata, dict):
            refined_note = metadata.get("refined_note_markdown") or metadata.get("note_markdown")
            raw_transcript = metadata.get("raw_transcript_markdown")

        if isinstance(refined_note, str) and refined_note.strip():
            sections = [refined_note.strip()]
            if isinstance(raw_transcript, str) and raw_transcript.strip():
                sections.extend(["", "---", "", raw_transcript.strip()])
            if include_annotations:
                annotations_block = self._build_annotations_block(metadata)
                if annotations_block:
                    sections.extend(["", "---", "", annotations_block])
            target_path.write_text("\n".join(sections).strip() + "\n", encoding="utf-8")
            return target_path

        lines = [
            f"# {content.get('title') or '未命名内容'}",
            "",
            f"- ID: {content.get('id', '-')}",
            f"- 平台: {content.get('platform') or '-'}",
            f"- 来源类型: {content.get('source_type') or '-'}",
            f"- 分类: {content.get('category') or '-'}",
            f"- 标签: {', '.join(content.get('tags') or []) or '-'}",
            f"- 创建时间: {content.get('created_at') or '-'}",
            f"- 更新时间: {content.get('updated_at') or '-'}",
            "",
            "## 摘要",
            "",
            content.get("summary") or "当前没有摘要。",
            "",
            "## 关键要点",
            "",
        ]

        key_points = content.get("key_points") or []
        if key_points:
            lines.extend([f"- {item}" for item in key_points])
        else:
            lines.append("- 当前没有关键要点。")

        lines.extend([
            "",
            "## 正文",
            "",
            content.get("content_text") or "当前没有正文。",
            "",
            "## Metadata",
            "",
            "```json",
            str(content.get("metadata") or {}),
            "```",
            "",
        ])

        if include_annotations:
            annotations_block = self._build_annotations_block(metadata)
            if annotations_block:
                lines.extend(["", "---", "", annotations_block, ""])

        target_path.write_text("\n".join(lines), encoding="utf-8")
        return target_path

    def _build_annotations_block(self, metadata: dict) -> str:
        annotations = metadata.get("user_annotations")
        if not isinstance(annotations, dict) or not annotations:
            return ""
        lines = ["## 批注"]
        for index, ann in sorted(annotations.items(), key=lambda x: int(x[0]) if str(x[0]).isdigit() else 0):
            if not isinstance(ann, dict):
                continue
            highlight = (ann.get("highlight") or "").strip()
            note = (ann.get("note") or "").strip()
            if not highlight and not note:
                continue
            lines.append(f"")
            lines.append(f"### 片段 {index}")
            if highlight:
                lines.append(f"> {highlight}")
            if note:
                lines.append(f"")
                lines.append(note)
        return "\n".join(lines)

    def _slugify(self, value: str) -> str:
        cleaned = re.sub(r"[\\/:*?\"<>|]", "-", value).strip()
        return cleaned[:80] or "content"
