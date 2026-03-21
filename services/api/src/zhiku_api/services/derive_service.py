from __future__ import annotations

import json
from typing import Any

from ..config import AppSettings
from .llm_gateway import LlmGateway


MINDMAP_PROMPT = """你是一个知识结构化助手。请根据下面的内容，生成一份思维导图结构（JSON格式）。

要求：
- 返回纯 JSON，不要 markdown 代码块
- 结构为：{"title": "主题", "children": [{"title": "子主题", "children": [...]}]}
- 主题层级不超过3层，每层不超过6个节点
- 节点标题简洁，不超过20字

内容：
{content}"""

QUIZ_PROMPT = """你是一个出题助手。请根据下面的内容，生成5道理解性选择题（JSON格式）。

要求：
- 返回纯 JSON 数组，不要 markdown 代码块
- 每题结构：{"question": "题目", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "answer": "A", "explanation": "解析"}
- 题目考察核心概念，选项设计合理，有迷惑性
- answer 字段只填 A/B/C/D

内容：
{content}"""


class DeriveService:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings
        self.llm = LlmGateway(settings)

    def _collect_content_text(self, content: dict[str, Any], chunks: list[dict[str, Any]]) -> str:
        parts: list[str] = []
        title = (content.get("title") or "").strip()
        if title:
            parts.append(f"标题：{title}")
        summary = (content.get("summary") or "").strip()
        if summary:
            parts.append(f"摘要：{summary}")
        if chunks:
            texts = [c.get("chunk_text") or "" for c in chunks[:12] if c.get("chunk_text")]
            parts.append("正文片段：\n" + "\n".join(texts))
        elif content.get("content_text"):
            parts.append("正文：" + str(content["content_text"])[:3000])
        return "\n\n".join(parts)

    def _call_llm_json(self, prompt: str) -> Any:
        try:
            raw = self.llm._chat(
                prompt,
                temperature=0.3,
                system_prompt="你是一个知识结构化助手，只返回纯 JSON，不加任何解释或 markdown 代码块。",
            )
        except Exception:
            return None
        if not raw:
            return None
        raw = raw.strip()
        if raw.startswith("```"):
            lines = raw.split("\n")
            raw = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        try:
            return json.loads(raw)
        except Exception:
            return None

    def generate_mindmap(self, content: dict[str, Any], chunks: list[dict[str, Any]]) -> dict[str, Any]:
        text = self._collect_content_text(content, chunks)
        prompt = MINDMAP_PROMPT.format(content=text)
        result = self._call_llm_json(prompt)
        if not isinstance(result, dict) or "title" not in result:
            title = (content.get("title") or "思维导图").strip()
            result = {"title": title, "children": []}
        return result

    def generate_quiz(self, content: dict[str, Any], chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
        text = self._collect_content_text(content, chunks)
        prompt = QUIZ_PROMPT.format(content=text)
        result = self._call_llm_json(prompt)
        if not isinstance(result, list):
            return []
        valid = []
        for item in result:
            if isinstance(item, dict) and item.get("question") and item.get("options") and item.get("answer"):
                valid.append(item)
        return valid[:5]
