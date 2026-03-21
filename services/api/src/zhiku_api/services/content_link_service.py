from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


def build_seek_url(source_url: str | None, start_ms: int | None | Any) -> str | None:
    if not source_url or not str(source_url).strip():
        return None

    milliseconds = _coerce_milliseconds(start_ms)
    if milliseconds is None:
        return None

    normalized_url = str(source_url).strip()
    try:
        parsed = urlparse(normalized_url)
    except Exception:
        return normalized_url

    if not parsed.scheme or not parsed.netloc:
        return normalized_url

    query_items = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key.lower() != "t"]
    query_items.append(("t", str(milliseconds // 1000)))
    return urlunparse(parsed._replace(query=urlencode(query_items)))


def _coerce_milliseconds(value: int | None | Any) -> int | None:
    if value is None:
        return None
    try:
        milliseconds = int(value)
    except (TypeError, ValueError):
        return None
    return milliseconds if milliseconds >= 0 else None
