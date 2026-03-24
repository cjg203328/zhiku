from __future__ import annotations

import json
from typing import Any

from ..config import AppSettings
from .llm_gateway import LlmGateway


MINDMAP_PROMPT = """根据下面的内容，生成一份思维导图结构（JSON格式）。

规则：
- 只返回 JSON，不加任何解释或 markdown 代码块
- 结构：{{"title": "核心主题", "children": [{{"title": "子主题", "children": [...]}}]}}
- 最多 3 层，每层最多 5 个节点
- 节点文字提炼自内容，不超过 15 字，不出现 BV 号、链接、播放量等无关信息
- 优先覆盖内容的核心结论、方法、步骤，而非目录标题

内容：
{content}"""

QUIZ_PROMPT = """根据下面的内容，生成 5 道理解性单选题（JSON 格式）。

规则：
- 只返回 JSON 数组，不加任何解释或 markdown 代码块
- 每题结构：{{"question": "题目", "options": ["A. ...", "B. ...", "C. ...", "D. ..."], "answer": "A", "explanation": "一句话解析"}}
- 题目考察内容的核心概念、关键结论或方法步骤
- 选项设计要有合理的迷惑性，但答案在内容中有明确依据
- answer 只填 A/B/C/D，explanation 简洁不超过 60 字
- 不要出考察 BV 号、播放量、UP 主名称等无关信息的题

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
