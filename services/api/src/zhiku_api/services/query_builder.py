"""QueryBuilderMixin — 查询变体生成、意图推断、Session 上下文。

从 chat_service.py 拆分，由 ChatService 通过 mixin 继承。
"""
from __future__ import annotations

import re
from typing import Any


class QueryBuilderMixin:
    """Query 预处理：变体扩展、意图分类、Session 上下文提取。"""

    def build_query_variants(
        self,
        query: str,
        *,
        session_messages: list[dict[str, Any]] | None = None,
        allow_context: bool = True,
        context_payload: dict[str, Any] | None = None,
    ) -> list[str]:
        cleaned = query.strip()
        if not cleaned:
            return []
        variants: list[str] = [cleaned]
        for item in self._build_heuristic_variants(cleaned):
            if item not in variants:
                variants.append(item)
        if allow_context and self._query_needs_context(cleaned):
            for item in self._build_context_variants(
                session_messages or [], query=cleaned, context_payload=context_payload
            ):
                if item not in variants:
                    variants.append(item)
        if self.llm_gateway is not None:  # type: ignore[attr-defined]
            for item in (self.llm_gateway.generate_query_rewrites(cleaned) or []):  # type: ignore[attr-defined]
                if item not in variants:
                    variants.append(item)
        return variants[:5]

    def _infer_query_intent(self, query: str) -> str:
        normalized = re.sub(r"\s+", "", query or "")
        if self._query_is_summary_like(query):
            return "summary"
        if any(m in normalized for m in ("对比", "区别", "差异", "不同", "优缺点", "哪个更")):
            return "compare"
        if any(m in normalized for m in ("为什么", "原因", "逻辑", "怎么判断")):
            return "reason"
        if any(m in normalized for m in ("如何", "怎么做", "步骤", "做法", "上手", "执行", "落地", "操作")):
            return "action"
        if any(m in normalized for m in ("要不要", "值不值得", "该不该", "适不适合", "能不能", "选哪个", "能买吗")):
            return "decision"
        return "explain"

    def _query_is_summary_like(self, query: str) -> bool:
        normalized = re.sub(r"\s+", "", query or "")
        return any(m in normalized for m in (
            "概括", "总结", "梳理", "提炼", "讲了什么", "说了什么",
            "主要内容", "核心内容", "重点", "结论", "值得记住", "复盘",
        ))

    def _query_needs_context(self, query: str) -> bool:
        normalized = re.sub(r"\s+", "", query or "")
        if not normalized:
            return False
        markers = (
            "这篇", "这个", "这条", "这里", "它", "上面", "前面", "刚才",
            "继续", "展开", "详细说", "细讲", "这部分", "这一段", "这个点",
            "然后", "那么", "本文", "该文", "该视频", "这视频",
        )
        return len(normalized) <= 12 or any(m in normalized for m in markers)

    def _build_heuristic_variants(self, query: str) -> list[str]:
        lowered = query.strip()
        normalized = re.sub(r"[？?。！!，,；;：:]+", " ", lowered)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        variants: list[str] = []
        stripped = normalized
        for pattern in [
            r"^(我想|我需要|请问|帮我|请帮我|我准备|我正在|我现在|能不能|如何|怎么|为什么|请你)\s*",
            r"\s*(讲讲|解释一下|总结一下|分析一下|告诉我|给我|做个总结|做一份总结)$",
        ]:
            stripped = re.sub(pattern, "", stripped, flags=re.IGNORECASE)
        stripped = stripped.strip()
        if stripped and stripped != query:
            variants.append(stripped)
        latin_terms = re.findall(r"[A-Za-z][A-Za-z0-9_\-]{1,31}", query)
        han_blocks = re.findall(r"[\u4e00-\u9fff]{2,18}", query)
        if latin_terms:
            variants.append(" ".join(latin_terms[:3]))
        for block in han_blocks[:2]:
            if block not in variants and block != query:
                variants.append(block)
        compact = " ".join([t for t in [*latin_terms, *han_blocks] if len(t) >= 2][:4]).strip()
        if compact:
            variants.append(compact)
        deduped: list[str] = []
        for item in variants:
            if item.strip() and item.strip() not in deduped:
                deduped.append(item.strip())
        return deduped[:4]

    def _build_context_variants(
        self,
        session_messages: list[dict[str, Any]],
        *,
        query: str | None = None,
        context_payload: dict[str, Any] | None = None,
    ) -> list[str]:
        payload = context_payload or self._build_session_context_payload(session_messages)
        if not payload:
            return []
        variants: list[str] = []
        last_user_query = str(payload.get("last_user_query") or "").strip()
        lead_title = str(payload.get("lead_title") or "").strip()
        assistant_focus = str(payload.get("assistant_focus") or "").strip()
        current_query = str(query or "").strip()
        for ctx in [lead_title, last_user_query, assistant_focus]:
            candidate = self._merge_query_with_context(current_query, ctx)
            if candidate and candidate not in variants:
                variants.append(candidate)
        recent = payload.get("recent_user_queries") if isinstance(payload.get("recent_user_queries"), list) else []
        for msg in recent[-2:]:
            n = re.sub(r"\s+", " ", str(msg or "")).strip()
            if n and n not in variants:
                variants.append(n)
            han = re.findall(r"[\u4e00-\u9fff]{2,12}", n)
            lat = re.findall(r"[A-Za-z][A-Za-z0-9_\-]{1,24}", n)
            merged = " ".join([*(han[:2]), *(lat[:2])]).strip()
            if merged and merged not in variants:
                variants.append(merged)
        for item in [lead_title, assistant_focus]:
            if item.strip() and item.strip() not in variants:
                variants.append(item.strip())
        deduped: list[str] = []
        for item in variants:
            if item.strip() and item.strip() not in deduped:
                deduped.append(item.strip())
        return deduped[:4]

    def _build_session_context_payload(self, session_messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not session_messages:
            return {}
        recent = session_messages[-6:]
        _LIMIT = 200
        truncated = [{**m, "message_text": str(m.get("message_text") or "")[:_LIMIT]} for m in recent]
        user_queries = [
            str(m.get("message_text") or "").strip()
            for m in truncated
            if m.get("role") == "user" and str(m.get("message_text") or "").strip()
        ]
        assistant_msgs = [
            m for m in truncated
            if m.get("role") == "assistant" and str(m.get("message_text") or "").strip()
        ]
        if not user_queries and not assistant_msgs:
            return {}
        citation_titles: list[str] = []
        for m in reversed(assistant_msgs):
            for c in (m.get("citations") or []):
                if isinstance(c, dict):
                    t = str(c.get("title") or "").strip()
                    if t and t not in citation_titles:
                        citation_titles.append(t)
        text_titles: list[str] = []
        for m in recent:
            for title in re.findall(r"《([^》]{2,40})》", str(m.get("message_text") or "")):
                if title.strip() and title.strip() not in text_titles:
                    text_titles.append(title.strip())
        lead_title = citation_titles[0] if citation_titles else (text_titles[0] if text_titles else "")
        latest_asst = str(assistant_msgs[-1].get("message_text") or "").strip() if assistant_msgs else ""
        assistant_focus = self._extract_context_focus_text(latest_asst)
        return {
            "recent_user_queries": user_queries[-2:],
            "last_user_query": user_queries[-1] if user_queries else "",
            "lead_title": lead_title,
            "assistant_focus": assistant_focus,
            "citation_titles": citation_titles[:3],
        }

    def _merge_query_with_context(self, query: str, context: str) -> str:
        q = re.sub(r"\s+", " ", query or "").strip()
        ctx = re.sub(r"\s+", " ", context or "").strip()
        if not q or not ctx:
            return ""
        if ctx in q or q in ctx:
            return q if len(q) >= len(ctx) else ctx
        if len(ctx) > 36:
            ctx = ctx[:36].rstrip()
        return f"{ctx} {q}".strip()

    def _extract_context_focus_text(self, text: str) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip()
        if not cleaned:
            return ""
        cleaned = re.sub(r"^(?:结论|当前判断|优先可参考的结论|建议下一步)[：:\s]*", "", cleaned)
        for sentence in re.split(r"(?<=[。！？!?；;])\s*", cleaned):
            if len(sentence.strip()) >= 8:
                return sentence.strip()[:48].rstrip()
        return cleaned[:48].rstrip()
