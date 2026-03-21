from __future__ import annotations

from collections import Counter
import re
from typing import Any


CHINESE_STOP_TERMS = {
    "视频",
    "内容",
    "知识",
    "笔记",
    "总结",
    "概括",
    "整理",
    "问题",
    "答案",
    "平台",
    "用户",
    "资料",
    "链接",
    "网页",
    "文章",
    "文档",
    "文件",
    "片段",
    "正文",
    "标题",
    "作者",
    "这里",
    "这个",
    "这条",
    "一个",
    "两个",
    "三个",
    "一种",
    "可以",
    "如何",
    "什么",
    "为主",
    "一下",
    "我们",
    "你们",
}


class ContentTermService:
    def extract(self, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        summary = str(payload.get("summary") or "").strip()
        author = str(payload.get("author") or "").strip()
        tags = [str(item).strip() for item in (payload.get("tags") or []) if str(item).strip()]
        key_points = [str(item).strip() for item in (payload.get("key_points") or []) if str(item).strip()]
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        refined_note = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
        content_text = str(payload.get("content_text") or "").strip()
        transcript_segments = metadata.get("transcript_segments") if isinstance(metadata.get("transcript_segments"), list) else []

        title_terms = self._extract_terms(" ".join([title, author, *tags]), strong=True)
        summary_terms = self._extract_terms(" ".join([summary, *key_points[:5]]), strong=False)
        transcript_text = " ".join(
            str(item.get("text") or "").strip()
            for item in transcript_segments[:10]
            if isinstance(item, dict) and str(item.get("text") or "").strip()
        )
        body_terms = self._extract_terms("\n".join([refined_note[:2000], content_text[:2000], transcript_text]), strong=False)

        body_counter = Counter(body_terms)
        primary_terms: list[str] = []
        for term in [*title_terms, *summary_terms]:
            if term not in primary_terms:
                primary_terms.append(term)
        for term, count in body_counter.most_common(24):
            if count < 2 and term not in title_terms:
                continue
            if term not in primary_terms:
                primary_terms.append(term)

        primary_terms = primary_terms[:20]
        topic_query = " ".join(primary_terms[:4]).strip()
        return {
            "primary_terms": primary_terms,
            "title_terms": title_terms[:8],
            "summary_terms": [term for term in summary_terms if term not in title_terms][:8],
            "tag_terms": tags[:8],
            "topic_query": topic_query,
        }

    def _extract_terms(self, text: str, *, strong: bool) -> list[str]:
        if not text.strip():
            return []

        candidates: list[str] = []
        candidates.extend(self._extract_quoted_terms(text))
        candidates.extend(re.findall(r"[A-Za-z0-9][A-Za-z0-9_\-\.]{1,31}", text))

        for block in re.findall(r"[\u4e00-\u9fff]{2,24}", text):
            cleaned_block = block.strip()
            if len(cleaned_block) <= 4:
                candidates.append(cleaned_block)
                continue

            if strong:
                candidates.append(cleaned_block[:12])
            for size in (4, 3, 2):
                for index in range(0, len(cleaned_block) - size + 1):
                    candidates.append(cleaned_block[index:index + size])

        deduped: list[str] = []
        for term in candidates:
            cleaned = self._normalize_term(term)
            if not cleaned:
                continue
            if cleaned not in deduped:
                deduped.append(cleaned)
        return deduped

    def _extract_quoted_terms(self, text: str) -> list[str]:
        items: list[str] = []
        for pattern in (r"《([^》]{2,24})》", r"“([^”]{2,24})”", r"\"([^\"]{2,24})\""):
            items.extend(re.findall(pattern, text))
        return items

    def _normalize_term(self, term: str) -> str | None:
        cleaned = re.sub(r"\s+", " ", term).strip().strip(".,:;!?()[]{}<>/\\'\"")
        if len(cleaned) < 2:
            return None
        lowered = cleaned.lower()
        if lowered in CHINESE_STOP_TERMS:
            return None
        if re.fullmatch(r"\d+", lowered):
            return None
        return cleaned
