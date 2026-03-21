from __future__ import annotations

from html import unescape
from html.parser import HTMLParser
import re
from typing import Any
from urllib import request as urllib_request
from urllib.parse import urlparse

from ..config import AppSettings
from .llm_gateway import LlmGateway


CONTENT_HINTS = ("article", "content", "post", "entry", "main", "body", "text", "detail", "read")


class WebpageParseError(RuntimeError):
    pass


class _ArticleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._ignore_depth = 0
        self._target_depth = 0
        self._title_depth = 0
        self._body_depth = 0
        self.title_parts: list[str] = []
        self.target_parts: list[str] = []
        self.body_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self._ignore_depth += 1
            return

        attrs_map = {key.lower(): (value or "") for key, value in attrs}
        attr_blob = " ".join([attrs_map.get("id", ""), attrs_map.get("class", "")]).lower()
        if tag == "title":
            self._title_depth += 1
        if tag == "body":
            self._body_depth += 1
        if tag in {"article", "main"} or any(hint in attr_blob for hint in CONTENT_HINTS):
            self._target_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"}:
            self._ignore_depth = max(0, self._ignore_depth - 1)
            return
        if tag == "title":
            self._title_depth = max(0, self._title_depth - 1)
        if tag == "body":
            self._body_depth = max(0, self._body_depth - 1)
        if self._target_depth > 0 and tag in {"article", "main", "div", "section"}:
            self._target_depth = max(0, self._target_depth - 1)

    def handle_data(self, data: str) -> None:
        if self._ignore_depth > 0:
            return
        cleaned = self._normalize_text(data)
        if not cleaned:
            return
        if self._title_depth > 0:
            self.title_parts.append(cleaned)
        if self._body_depth > 0:
            self.body_parts.append(cleaned)
        if self._target_depth > 0:
            self.target_parts.append(cleaned)

    def _normalize_text(self, value: str) -> str:
        cleaned = unescape(value or "")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if len(cleaned) <= 1:
            return ""
        return cleaned


class WebpageService:
    def __init__(self, settings: AppSettings | None = None, *, timeout_seconds: float = 12.0) -> None:
        self.settings = settings
        self.timeout_seconds = timeout_seconds
        self.llm_gateway = LlmGateway(settings) if settings is not None else None

    def parse(self, raw_url: str, *, note_style: str = "structured", summary_focus: str = "") -> dict[str, Any]:
        url = self._normalize_url(raw_url)
        html = self._fetch_html(url)
        title = self._extract_title(html) or self._host_title(url)
        description = self._extract_meta(html, "description") or self._extract_meta(html, "og:description") or ""
        author = self._extract_meta(html, "author") or None
        keywords = self._extract_meta(html, "keywords") or ""
        content_text, content_source = self._extract_content(html)

        if len(content_text) < 80:
            raise WebpageParseError("网页正文过短，暂时无法整理出可用内容")

        summary = description.strip() or self._build_summary(content_text)
        key_points = self._build_key_points(content_text)
        tags = self._build_tags(url, keywords)
        note_markdown = self._build_note_markdown(
            title=title,
            url=url,
            summary=summary,
            key_points=key_points,
            content_text=content_text,
            note_style=note_style,
            summary_focus=summary_focus,
        )

        llm_enhanced = self._enhance_with_llm(
            title=title,
            author=author,
            source_url=url,
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
            "platform": "webpage",
            "source_url": url,
            "title": title,
            "author": author,
            "content_text": content_text,
            "summary": summary,
            "key_points": key_points,
            "quotes": [],
            "category": "网页收藏",
            "content_type": "article",
            "use_case": "学习",
            "tags": tags,
            "metadata": {
                "host": urlparse(url).netloc,
                "parse_mode": "webpage_extract",
                "content_source": content_source,
                "description_length": len(description.strip()),
                "extracted_text_length": len(content_text),
                "note_style": note_style,
                "summary_focus": summary_focus,
                "note_markdown": note_markdown,
                "llm_enhanced": bool(llm_enhanced),
                "model_provider": self.settings.model_provider if self.settings is not None else "builtin",
            },
            "local_path": None,
            "status": "ready",
        }

    def _normalize_url(self, raw_url: str) -> str:
        candidate = raw_url.strip()
        if not candidate:
            raise WebpageParseError("链接为空")
        if not candidate.startswith(("http://", "https://")):
            candidate = f"https://{candidate}"
        return candidate

    def _fetch_html(self, url: str) -> str:
        request = urllib_request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 Zhiku/0.1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
            method="GET",
        )
        try:
            with urllib_request.urlopen(request, timeout=self.timeout_seconds) as response:
                charset = response.headers.get_content_charset() or "utf-8"
                return response.read().decode(charset, errors="ignore")
        except Exception as exc:
            raise WebpageParseError("网页抓取失败") from exc

    def _extract_title(self, html: str) -> str | None:
        parser = _ArticleTextParser()
        parser.feed(html)
        title = " ".join(parser.title_parts).strip()
        if title:
            return title
        return self._extract_meta(html, "og:title")

    def _extract_meta(self, html: str, name: str) -> str | None:
        patterns = [
            rf'<meta[^>]+property=["\']{re.escape(name)}["\'][^>]+content=["\'](.*?)["\']',
            rf'<meta[^>]+name=["\']{re.escape(name)}["\'][^>]+content=["\'](.*?)["\']',
            rf'<meta[^>]+content=["\'](.*?)["\'][^>]+property=["\']{re.escape(name)}["\']',
            rf'<meta[^>]+content=["\'](.*?)["\'][^>]+name=["\']{re.escape(name)}["\']',
        ]
        for pattern in patterns:
            match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
            if match:
                value = re.sub(r"\s+", " ", unescape(match.group(1))).strip()
                if value:
                    return value
        return None

    def _extract_content(self, html: str) -> tuple[str, str]:
        parser = _ArticleTextParser()
        parser.feed(html)

        target_text = self._join_text(parser.target_parts)
        body_text = self._join_text(parser.body_parts)

        if len(target_text) >= 200:
            return target_text, "article_like"
        if len(body_text) >= 120:
            return body_text, "body_fallback"
        return target_text or body_text, "weak_extract"

    def _join_text(self, parts: list[str]) -> str:
        merged: list[str] = []
        seen: set[str] = set()
        for item in parts:
            cleaned = item.strip()
            if len(cleaned) < 2:
                continue
            if cleaned in seen:
                continue
            seen.add(cleaned)
            merged.append(cleaned)
        text = "\n".join(merged)
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        return text[:16000]

    def _build_summary(self, content_text: str) -> str:
        compact = content_text.replace("\n", " ").strip()
        return compact[:160] + ("..." if len(compact) > 160 else "")

    def _build_key_points(self, content_text: str) -> list[str]:
        segments = [segment.strip() for segment in re.split(r"[\n。！？!?]", content_text) if segment.strip()]
        points: list[str] = []
        for segment in segments:
            if segment not in points:
                points.append(segment)
            if len(points) >= 4:
                break
        return points or [content_text[:80]]

    def _build_tags(self, url: str, keywords: str) -> list[str]:
        host = urlparse(url).netloc.replace("www.", "").strip()
        tags = ["网页", host] if host else ["网页"]
        keyword_items = [item.strip() for item in re.split(r"[，,、]", keywords) if item.strip()]
        for item in keyword_items[:3]:
            if item not in tags:
                tags.append(item)
        return tags

    def _build_note_markdown(
        self,
        *,
        title: str,
        url: str,
        summary: str,
        key_points: list[str],
        content_text: str,
        note_style: str,
        summary_focus: str,
    ) -> str:
        lines = [
            f"# {title}",
            "",
            "## 来源信息",
            "",
            f"- 链接: {url}",
            f"- 笔记风格: {note_style}",
            "",
        ]
        if summary_focus.strip():
            lines.extend(["## 本次关注点", "", summary_focus.strip(), ""])
        lines.extend(["## 一句话摘要", "", summary, "", "## 核心要点", ""])
        lines.extend([f"- {item}" for item in key_points] or ["- 当前未提炼出核心要点。"])
        lines.extend(["", "## 正文整理", "", content_text])
        return "\n".join(lines)

    def _enhance_with_llm(
        self,
        *,
        title: str,
        author: str | None,
        source_url: str,
        content_text: str,
        note_style: str,
        summary_focus: str,
    ) -> dict[str, Any] | None:
        if self.llm_gateway is None:
            return None
        return self.llm_gateway.enhance_import_result(
            title=title,
            author=author,
            source_url=source_url,
            content_text=content_text,
            note_style=note_style,
            summary_focus=summary_focus,
        )

    def _host_title(self, url: str) -> str:
        parsed = urlparse(url)
        return parsed.netloc or "网页内容"
