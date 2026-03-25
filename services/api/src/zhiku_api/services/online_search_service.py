from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlparse
from urllib.request import Request, urlopen


@dataclass
class WebSearchResult:
    title: str
    url: str
    snippet: str
    provider: str = "duckduckgo"


class _DuckDuckGoHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[WebSearchResult] = []
        self._current: dict[str, str] | None = None
        self._capture: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key: value or "" for key, value in attrs}
        class_name = attributes.get("class", "")
        if tag != "a":
            return

        if "result__a" in class_name:
            self._flush_current()
            self._current = {
                "title": "",
                "url": attributes.get("href", "").strip(),
                "snippet": "",
            }
            self._capture = "title"
            return

        if "result__snippet" in class_name and self._current is not None:
            self._capture = "snippet"

    def handle_endtag(self, tag: str) -> None:
        if tag == "a":
            self._capture = None

    def handle_data(self, data: str) -> None:
        if self._capture is None or self._current is None:
            return
        self._current[self._capture] = f"{self._current.get(self._capture, '')}{data}"

    def close(self) -> None:
        super().close()
        self._flush_current()

    def _flush_current(self) -> None:
        if self._current is None:
            return
        title = _clean_text(self._current.get("title", ""))
        url = _resolve_duckduckgo_href(self._current.get("url", ""))
        snippet = _clean_text(self._current.get("snippet", ""))
        if title and url:
            self.results.append(
                WebSearchResult(
                    title=title,
                    url=url,
                    snippet=snippet,
                )
            )
        self._current = None
        self._capture = None


def _clean_text(value: str) -> str:
    cleaned = re.sub(r"\s+", " ", str(value or "")).strip()
    return cleaned[:280].rstrip()


def _resolve_duckduckgo_href(href: str) -> str:
    candidate = str(href or "").strip()
    if not candidate:
        return ""
    if candidate.startswith("//"):
        candidate = f"https:{candidate}"
    parsed = urlparse(candidate)
    if "duckduckgo.com" not in parsed.netloc or not parsed.path.startswith("/l/"):
        return candidate
    uddg = parse_qs(parsed.query).get("uddg", [""])[0]
    return unquote(uddg).strip() or candidate


class OnlineSearchService:
    SEARCH_ENDPOINT = "https://html.duckduckgo.com/html/"

    def __init__(self, *, timeout_seconds: float = 12.0) -> None:
        self.timeout_seconds = max(4.0, float(timeout_seconds or 12.0))

    def search(self, query: str, *, limit: int = 5) -> list[dict[str, Any]]:
        normalized_query = _clean_text(query)
        if not normalized_query:
            return []

        url = f"{self.SEARCH_ENDPOINT}?q={quote(normalized_query)}"
        request = Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0 Safari/537.36",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            method="GET",
        )

        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                html = response.read().decode("utf-8", errors="ignore")
        except (HTTPError, URLError, TimeoutError):
            return []
        except Exception:
            return []

        parser = _DuckDuckGoHtmlParser()
        parser.feed(html)
        parser.close()

        deduped: list[dict[str, Any]] = []
        seen_urls: set[str] = set()
        for item in parser.results:
            if item.url in seen_urls:
                continue
            seen_urls.add(item.url)
            deduped.append(
                {
                    "title": item.title,
                    "url": item.url,
                    "snippet": item.snippet,
                    "provider": item.provider,
                }
            )
            if len(deduped) >= max(1, limit):
                break
        return deduped
