"""Bilibili HTTP 客户端层，封装请求头构建和底层 HTTP 调用。

BilibiliService 通过 json_fetcher/text_fetcher/url_resolver 注入这里的方法。
独立出来后可单独 mock 测试，也可替换为 httpx/aiohttp 实现。
"""
from __future__ import annotations

import json
from typing import Any
from urllib.request import Request, urlopen

BILIBILI_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
)

_ATTEMPT_HEADERS = (
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


class BilibiliParseError(RuntimeError):
    pass


class BilibiliHttpClient:
    """封装 B 站 HTTP 请求的底层实现，可被测试 mock 或整体替换。"""

    def __init__(self, *, timeout_seconds: float = 12.0, cookie: str | None = None) -> None:
        self.timeout_seconds = timeout_seconds
        self.cookie = cookie

    def build_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers: dict[str, str] = {
            "User-Agent": BILIBILI_BROWSER_UA,
            "Referer": "https://www.bilibili.com/",
            "Origin": "https://www.bilibili.com",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        }
        if self.cookie:
            headers["Cookie"] = self.cookie
        if extra:
            headers.update(extra)
        return headers

    def fetch_json(self, url: str) -> dict[str, Any]:
        payload = ""
        last_error: Exception | None = None
        for extra in _ATTEMPT_HEADERS:
            req = Request(url, headers=self.build_headers(extra))
            try:
                with urlopen(req, timeout=self.timeout_seconds) as resp:
                    payload = resp.read().decode("utf-8", errors="ignore")
                    last_error = None
                    break
            except Exception as exc:
                last_error = exc

        if last_error is not None:
            raise BilibiliParseError("访问 B 站接口失败") from last_error

        try:
            data = json.loads(payload)
        except Exception as exc:
            raise BilibiliParseError("B 站接口返回了非 JSON 数据") from exc

        if not isinstance(data, dict):
            raise BilibiliParseError("B 站接口数据格式异常")
        return data

    def fetch_text(self, url: str) -> str:
        last_error: Exception | None = None
        for extra in _ATTEMPT_HEADERS:
            req = Request(url, headers=self.build_headers(extra))
            try:
                with urlopen(req, timeout=self.timeout_seconds) as resp:
                    return resp.read().decode("utf-8", errors="ignore")
            except Exception as exc:
                last_error = exc
        raise BilibiliParseError("访问 B 站页面失败") from last_error

    def resolve_url(self, url: str) -> str:
        req = Request(url, headers=self.build_headers(), method="GET")
        try:
            with urlopen(req, timeout=self.timeout_seconds) as resp:
                return resp.geturl()
        except Exception as exc:
            if "b23.tv" in url.lower():
                raise BilibiliParseError("B 站短链解析失败") from exc
            return url
