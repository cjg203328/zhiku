from __future__ import annotations

import re
from typing import Any

from ..config import AppSettings
from .content_link_service import build_seek_url
from .llm_gateway import LlmGateway
from .note_quality_service import NoteQualityService
from .query_builder import QueryBuilderMixin
from .retrieval import RetrievalMixin


class ChatService(QueryBuilderMixin, RetrievalMixin):
    def __init__(self, settings: AppSettings | None = None) -> None:
        self.settings = settings
        self.llm_gateway = LlmGateway(settings) if settings is not None else None
        self.note_quality_service = NoteQualityService()

    def answer(
        self,
        query: str,
        *,
        repository: Any,
        limit: int = 5,
        content_id: str | None = None,
        chunk_id: str | None = None,
        session_messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        scoped = bool(content_id or chunk_id)
        query_intent = self._infer_query_intent(query)
        context_payload = self._build_session_context_payload(session_messages or []) if not scoped else {}
        follow_up_context = bool(
            not scoped
            and self._query_needs_context(query)
            and any(
                str(context_payload.get(key) or "").strip()
                for key in ("lead_title", "last_user_query", "assistant_focus")
            )
        )
        query_variants = self.build_query_variants(
            query,
            session_messages=session_messages,
            allow_context=not scoped,
            context_payload=context_payload,
        )
        scoped_content = repository.get_content(content_id) if content_id else None

        if chunk_id:
            chunk_matches = repository.search_content_chunks(
                query,
                limit=max(limit, 6),
                content_id=content_id,
                chunk_id=chunk_id,
            )
            content_matches: list[dict[str, Any]] = []
        elif content_id:
            chunk_matches = self._collect_scoped_chunk_matches(
                repository,
                query_variants,
                content_id=content_id,
                limit=max(limit, 8),
            )
            chunk_matches = self._augment_scoped_matches_with_content_terms(
                repository,
                content=scoped_content,
                query=query,
                matches=chunk_matches,
                limit=max(limit, 8),
            )
            chunk_matches = self._augment_scoped_matches_with_note_layer(
                content=scoped_content,
                query=query,
                matches=chunk_matches,
                limit=max(limit, 8),
            )
            content_matches = []
        else:
            content_matches = self._collect_content_matches(repository, query_variants, limit=max(limit * 2, 8))
            prioritized_content_ids = [str(item.get("id")) for item in content_matches[:3] if item.get("id")]
            chunk_matches = self._collect_chunk_matches(
                repository,
                query_variants,
                limit=max(limit * 2, 8),
                prioritized_content_ids=prioritized_content_ids,
            )

        fused_matches = self._fuse_matches(chunk_matches, content_matches, limit=max(limit, 6))
        fused_matches = self._reshape_matches_for_query(
            query,
            fused_matches,
            scoped=scoped,
            limit=max(limit, 6),
        )
        focus_context = self._resolve_focus_content_context(
            repository=repository,
            query=query,
            matches=fused_matches,
            scoped_content=scoped_content,
            scoped=scoped,
        )
        quality = self._evaluate_quality(
            fused_matches,
            scoped=scoped,
            session_messages=session_messages,
        )
        result = self._answer_from_fused_matches(
            query,
            fused_matches,
            session_messages=session_messages,
            quality=quality,
            scoped_content=scoped_content,
            focus_content=focus_context.get("content"),
            focus_context=focus_context,
            query_intent=query_intent,
        )
        result["retrieval"] = {
            "query_variants": query_variants,
            "query_intent": query_intent,
            "routes": {
                "chunk_hits": len(chunk_matches),
                "content_hits": len(content_matches),
                "fused_hits": len(fused_matches),
                "scoped": scoped,
                "hierarchical": bool(not scoped and content_matches),
                "content_targets": len([item for item in content_matches[:3] if item.get("id")]),
                "session_context_used": len(session_messages or []),
            },
            "paths": [
                {
                    "content_id": str(item.get("id")),
                    "title": item.get("title") or "未命名内容",
                    "score": round(float(item.get("score", 0)), 2),
                }
                for item in content_matches[:3]
                if item.get("id")
            ],
            "focus": {
                "mode": str(focus_context.get("focus_mode") or "mixed"),
                "auto_focused": bool(focus_context.get("auto_focused")),
                "content_id": str(focus_context.get("content_id") or "").strip() or None,
                "title": str(focus_context.get("title") or "").strip() or None,
                "matched_count": int(focus_context.get("matched_count") or 0),
                "score_share": round(float(focus_context.get("score_share") or 0), 2),
            },
            "context": {
                "follow_up": follow_up_context,
                "lead_title": str(context_payload.get("lead_title") or "").strip() or None,
                "recent_question": str(context_payload.get("last_user_query") or "").strip() or None,
            },
        }
        result["quality"] = result.get("quality") or quality
        return result

    # -------------------------------------------------------------------------
    # Section: Query Builder — query variant generation and session context
    # Future: extract to query_builder.py
    # -------------------------------------------------------------------------

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
        heuristic_variants = self._build_heuristic_variants(cleaned)
        for item in heuristic_variants:
            if item not in variants:
                variants.append(item)

        if allow_context and self._query_needs_context(cleaned):
            context_variants = self._build_context_variants(
                session_messages or [],
                query=cleaned,
                context_payload=context_payload,
            )
            for item in context_variants:
                if item not in variants:
                    variants.append(item)

        if self.llm_gateway is not None:
            llm_variants = self.llm_gateway.generate_query_rewrites(cleaned) or []
            for item in llm_variants:
                if item not in variants:
                    variants.append(item)

        return variants[:5]

    # -------------------------------------------------------------------------
    # Section: Retrieval — chunk/content match collection and scoring
    # Future: extract to retrieval.py
    # -------------------------------------------------------------------------

    def _collect_chunk_matches(
        self,
        repository: Any,
        query_variants: list[str],
        *,
        limit: int,
        prioritized_content_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        if prioritized_content_ids:
            return self._collect_hierarchical_chunk_matches(
                repository,
                query_variants,
                prioritized_content_ids=prioritized_content_ids,
                limit=limit,
            )

        collected: dict[str, dict[str, Any]] = {}
        for variant_index, variant in enumerate(query_variants):
            rows = repository.search_content_chunks(variant, limit=limit)
            for rank, row in enumerate(rows):
                key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted,
                    base_score=float(row.get("score", 0)) + self._route_boost("chunk", variant_index, rank),
                )
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        return sorted(collected.values(), key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    def _collect_scoped_chunk_matches(
        self,
        repository: Any,
        query_variants: list[str],
        *,
        content_id: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for variant_index, variant in enumerate(query_variants):
            rows = repository.search_content_chunks(
                variant,
                limit=limit,
                content_id=content_id,
                chunk_id=None,
            )
            for rank, row in enumerate(rows):
                key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted,
                    base_score=float(row.get("score", 0)) + self._route_boost("chunk", variant_index, rank),
                )
                boosted["retrieval_path"] = "scoped_chunk"
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        return sorted(collected.values(), key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    def _augment_scoped_matches_with_content_terms(
        self,
        repository: Any,
        *,
        content: dict[str, Any] | None,
        query: str,
        matches: list[dict[str, Any]],
        limit: int,
    ) -> list[dict[str, Any]]:
        if content is None:
            return matches[:limit]

        current_max_score = max((float(item.get("score", 0)) for item in matches), default=0.0)
        if current_max_score >= 5.0 and len(matches) >= min(3, limit):
            return matches[:limit]

        local_variants = self._build_content_term_variants(content, query)
        if not local_variants:
            return matches[:limit]

        content_id = str(content.get("id") or "").strip()
        if not content_id:
            return matches[:limit]

        extra_matches = self._collect_scoped_chunk_matches(
            repository,
            local_variants,
            content_id=content_id,
            limit=limit,
        )
        if not extra_matches:
            return matches[:limit]

        merged: dict[str, dict[str, Any]] = {}
        for item in [*matches, *extra_matches]:
            key = str(item.get("chunk_id") or f"{item.get('content_id')}::{item.get('chunk_index', 0)}")
            boosted = dict(item)
            if item in extra_matches:
                boosted["score"] = float(item.get("score", 0)) + 0.35
                boosted["retrieval_path"] = boosted.get("retrieval_path") or "scoped_local_terms"
            if key not in merged or float(boosted.get("score", 0)) > float(merged[key].get("score", 0)):
                merged[key] = boosted
        return sorted(merged.values(), key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    def _augment_scoped_matches_with_note_layer(
        self,
        *,
        content: dict[str, Any] | None,
        query: str,
        matches: list[dict[str, Any]],
        limit: int,
    ) -> list[dict[str, Any]]:
        if content is None:
            return matches[:limit]

        summary_like = self._query_is_summary_like(query)
        current_max_score = max((float(item.get("score", 0)) for item in matches), default=0.0)
        if not summary_like:
            if current_max_score >= 2.0 and matches:
                return matches[:limit]
            if len(matches) >= min(2, limit):
                return matches[:limit]

        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        refined_note = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
        summary = str(content.get("summary") or "").strip()
        key_points = [str(item).strip() for item in (content.get("key_points") or []) if str(item).strip()]
        note_body_parts = [part for part in [summary, *key_points[:4], refined_note[:1200]] if part]
        note_body = "\n".join(note_body_parts).strip()
        if not note_body:
            return matches[:limit]

        synthetic_match = {
            "content_id": str(content.get("id") or ""),
            "chunk_id": None,
            "chunk_index": -1,
            "heading": "精炼笔记",
            "title": content.get("title") or "未命名内容",
            "platform": content.get("platform"),
            "source_type": content.get("source_type"),
            "source_url": content.get("source_url"),
            "summary": summary,
            "chunk_summary": summary or (key_points[0] if key_points else ""),
            "snippet": self._build_scoped_note_snippet(
                query.strip(),
                summary=summary,
                key_points=key_points,
                refined_note=refined_note,
            ),
            "chunk_text": note_body,
            "route_type": "note",
            "retrieval_path": "scoped_note_layer",
            "status": content.get("status"),
            "metadata": metadata,
            "chunk_metadata": {},
            "key_points": key_points,
            "refined_note": refined_note,
        }
        synthetic_match["score"] = self._apply_quality_boost(
            synthetic_match,
            base_score=max(
                current_max_score,
                7.4 if summary_like and query.strip() else 6.2 if summary_like else 2.6 if query.strip() else 4.2,
            ),
        )

        deduped = [item for item in matches if str(item.get("heading") or "").strip() != "精炼笔记"]
        deduped.append(synthetic_match)
        return sorted(deduped, key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    def _collect_hierarchical_chunk_matches(
        self,
        repository: Any,
        query_variants: list[str],
        *,
        prioritized_content_ids: list[str],
        limit: int,
    ) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        target_rank_map = {content_id: index for index, content_id in enumerate(prioritized_content_ids)}

        for content_id in prioritized_content_ids:
            content_rank = target_rank_map.get(content_id, 0)
            for variant_index, variant in enumerate(query_variants):
                rows = repository.search_content_chunks(
                    variant,
                    limit=max(4, limit // max(len(prioritized_content_ids), 1)),
                    content_id=content_id,
                )
                for rank, row in enumerate(rows):
                    key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                    boosted = dict(row)
                    boosted["score"] = self._apply_quality_boost(
                        boosted,
                        base_score=(
                            float(row.get("score", 0))
                            + self._route_boost("chunk", variant_index, rank)
                            + max(0.0, 1.2 - content_rank * 0.22)
                        ),
                    )
                    boosted["retrieval_path"] = "content_to_chunk"
                    if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                        collected[key] = boosted

        if len(collected) < max(3, limit // 2):
            for variant_index, variant in enumerate(query_variants):
                rows = repository.search_content_chunks(variant, limit=limit)
                for rank, row in enumerate(rows):
                    key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                    boosted = dict(row)
                    boosted["score"] = self._apply_quality_boost(
                        boosted,
                        base_score=float(row.get("score", 0)) + self._route_boost("chunk", variant_index, rank),
                    )
                    boosted["retrieval_path"] = boosted.get("retrieval_path") or "global_chunk"
                    if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                        collected[key] = boosted

        return sorted(collected.values(), key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    def _collect_content_matches(self, repository: Any, query_variants: list[str], *, limit: int) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for variant_index, variant in enumerate(query_variants):
            rows = repository.search_contents(variant, limit=limit)
            for rank, row in enumerate(rows):
                key = str(row.get("id"))
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted,
                    base_score=float(row.get("score", 0)) + self._route_boost("content", variant_index, rank),
                )
                boosted["route_type"] = "content"
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        return sorted(collected.values(), key=lambda item: float(item.get("score", 0)), reverse=True)[:limit]

    @staticmethod
    def _minmax_normalize(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """在列表内对 score 做 min-max 归一化，返回新列表。"""
        if not items:
            return items
        scores = [float(item.get("score", 0)) for item in items]
        lo, hi = min(scores), max(scores)
        span = hi - lo
        result = []
        for item, score in zip(items, scores):
            normalized = dict(item)
            normalized["score"] = (score - lo) / span if span > 0 else 1.0
            result.append(normalized)
        return result

    def _fuse_matches(
        self,
        chunk_matches: list[dict[str, Any]],
        content_matches: list[dict[str, Any]],
        *,
        limit: int,
    ) -> list[dict[str, Any]]:
        seen_chunk_ids: set[str] = set()
        seen_content_ids: set[str] = set()
        candidates: list[dict[str, Any]] = []

        # 归一化后合并
        for item in self._minmax_normalize(chunk_matches):
            key = str(
                item.get("chunk_id")
                or f"{item.get('content_id')}::{item.get('route_type') or 'chunk'}::{item.get('heading') or item.get('chunk_index', 0)}"
            )
            if key and key not in seen_chunk_ids:
                normalized = dict(item)
                normalized["route_type"] = normalized.get("route_type") or "chunk"
                normalized["title"] = normalized.get("title") or "未命名内容"
                normalized["snippet"] = normalized.get("snippet") or normalized.get("chunk_summary") or ""
                candidates.append(normalized)
                seen_chunk_ids.add(key)
                if normalized.get("content_id"):
                    seen_content_ids.add(str(normalized["content_id"]))

        for item in self._minmax_normalize(content_matches):
            content_key = str(item.get("id") or "")
            if not content_key or content_key in seen_content_ids:
                continue
            normalized = {
                "content_id": content_key,
                "chunk_id": None,
                "chunk_index": None,
                "heading": None,
                "title": item.get("title") or "未命名内容",
                "platform": item.get("platform"),
                "source_type": item.get("source_type"),
                "source_url": item.get("source_url"),
                "summary": item.get("summary"),
                "chunk_summary": item.get("summary"),
                "snippet": item.get("snippet") or item.get("summary") or "",
                "score": float(item.get("score", 0)),
                "route_type": "content",
                "status": item.get("status"),
                "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
            }
            candidates.append(normalized)
            seen_content_ids.add(content_key)

        # 统一按归一化 score 降序截断
        candidates.sort(key=lambda row: float(row.get("score", 0)), reverse=True)
        return candidates[:limit]

    # -------------------------------------------------------------------------
    # Section: Answer Generator — LLM prompt building and answer synthesis
    # Future: extract to answer_generator.py
    # -------------------------------------------------------------------------

    def _answer_from_fused_matches(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        session_messages: list[dict[str, Any]] | None,
        quality: dict[str, Any],
        scoped_content: dict[str, Any] | None = None,
        focus_content: dict[str, Any] | None = None,
        focus_context: dict[str, Any] | None = None,
        query_intent: str | None = None,
    ) -> dict[str, Any]:
        if not matches:
            return self.answer_from_matches(
                query,
                matches,
                quality=quality,
                query_intent=query_intent,
                session_messages=session_messages,
            )

        top_matches = matches[:4]
        citations = [
            {
                "content_id": item.get("content_id") or item.get("id"),
                "chunk_id": item.get("chunk_id"),
                "chunk_index": item.get("chunk_index"),
                "heading": item.get("heading"),
                "title": item.get("title") or "未命名内容",
                "snippet": item.get("snippet") or item.get("chunk_summary") or item.get("summary") or "",
                "score": float(item.get("score", 0)),
                "platform": item.get("platform"),
                "source_url": item.get("source_url"),
                "start_ms": self._read_chunk_milliseconds(item, "start_ms"),
                "end_ms": self._read_chunk_milliseconds(item, "end_ms"),
                "seek_url": self._read_chunk_seek_url(item),
            }
            for item in top_matches
        ]
        strategy_content = focus_content or scoped_content
        answer_strategy = self._resolve_answer_strategy(
            strategy_content,
            quality,
            focus_context=focus_context,
        )
        quality = dict(quality or {})
        quality["answer_strategy"] = answer_strategy["mode"]
        quality["llm_recommended"] = answer_strategy["llm_recommended"]
        quality["semantic_score"] = answer_strategy["semantic_score"]
        quality["query_intent"] = query_intent or self._infer_query_intent(query)
        if focus_context is not None:
            quality["focus_mode"] = focus_context.get("focus_mode")
            quality["focus_title"] = focus_context.get("title")
            quality["focus_score_share"] = focus_context.get("score_share")
        if answer_strategy.get("quality_summary"):
            quality["content_quality_summary"] = answer_strategy["quality_summary"]
        if quality.get("level") != "blocked":
            strategy_summary = self._build_answer_strategy_summary(answer_strategy, focus_context, quality)
            if strategy_summary:
                quality["summary"] = strategy_summary
        if answer_strategy.get("recommended_action"):
            quality["recommended_action"] = answer_strategy["recommended_action"]
        follow_ups = self._build_follow_ups(
            query,
            top_matches,
            query_intent=quality.get("query_intent") or query_intent,
            focus_content=strategy_content,
            focus_context=focus_context,
            quality=quality,
        )

        if quality.get("level") == "blocked":
            return {
                "answer": self._build_blocked_source_answer(query, top_matches, quality),
                "citations": citations,
                "follow_ups": follow_ups,
                "mode": "rag_source_blocked",
                "quality": quality,
            }

        if answer_strategy["prefers_agent"] and answer_strategy["llm_available"] and strategy_content is not None and self.llm_gateway is not None:
            llm_result = self.llm_gateway.generate_scoped_content_answer(
                query,
                strategy_content,
                top_matches,
                quality=quality,
                conversation_context=session_messages,
                query_intent=query_intent,
            )
            if llm_result is not None:
                return {
                    "answer": self._polish_generated_answer(llm_result.text),
                    "citations": citations,
                    "follow_ups": follow_ups,
                    "mode": "rag_agent_answer",
                    "quality": quality,
                }

        if answer_strategy["needs_model"]:
            return {
                "answer": self._build_agent_upgrade_answer(query, strategy_content, top_matches, quality),
                "citations": citations,
                "follow_ups": follow_ups,
                "mode": "rag_agent_pending",
                "quality": quality,
            }

        if quality.get("degraded"):
            return {
                "answer": self._build_weak_evidence_answer(query, top_matches, quality),
                "citations": citations,
                "follow_ups": follow_ups,
                "mode": "rag_weak_evidence",
                "quality": quality,
            }

        if self.llm_gateway is not None:
            llm_result = self.llm_gateway.generate_answer(
                query,
                top_matches,
                conversation_context=session_messages,
                query_intent=query_intent,
            )
            if llm_result is not None:
                return {
                    "answer": self._polish_generated_answer(llm_result.text),
                    "citations": citations,
                    "follow_ups": follow_ups,
                    "mode": "rag_fused_answer",
                    "quality": quality,
                }

        return {
            "answer": self._build_natural_fallback_answer(query, top_matches, quality),
            "citations": citations,
            "follow_ups": follow_ups,
            "mode": "rag_fused_retrieval",
            "quality": quality,
        }

    def answer_from_matches(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        quality: dict[str, Any] | None = None,
        query_intent: str | None = None,
        session_messages: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not matches:
            if self.llm_gateway is not None:
                llm_result = self.llm_gateway.generate_general_answer(
                    query,
                    query_intent=query_intent or self._infer_query_intent(query),
                    conversation_context=session_messages,
                )
                if llm_result is not None:
                    fallback_quality = dict(quality or {})
                    fallback_quality.update(
                        {
                            "source": "general_model",
                            "grounded": False,
                            "degraded": True,
                            "label": "未命中知识库",
                            "summary": "当前没有检索到可支撑回答的知识库证据，以下内容来自通用模型能力。",
                            "recommended_action": "如果你希望答案更贴近自己的资料，先导入相关内容后再追问。",
                        }
                    )
                    return {
                        "answer": self._format_answer_sections(
                            conclusion="当前没有命中知识库，这里先给你一版通用回答，适合先做方向判断。",
                            status_line=fallback_quality.get("summary"),
                            evidence_title="通用回答",
                            evidence_lines=[self._polish_generated_answer(llm_result.text)],
                            next_title="如果你想让后续回答更贴近你的资料",
                            next_steps=[
                                "先导入一条与这个主题直接相关的内容。",
                                "把问题缩小到一个更明确的目标后再问。",
                                "继续追问时，尽量带上场景、对象或限制条件。",
                            ],
                        ),
                        "citations": [],
                        "follow_ups": [
                            "把这个问题拆成 3 个更具体的小问题",
                            "先导入一条和这个主题相关的内容再继续追问",
                            "请给我一份可执行的入门学习路径",
                        ],
                        "mode": "llm_general_answer",
                        "quality": fallback_quality,
                    }
            return {
                "answer": "我在你的知识库里没有检索到足够相关的内容。建议先导入相关资料，或换一个更具体的问题再试。",
                "citations": [],
                "follow_ups": [
                    "换一个更具体的问题再试一次",
                    "先去知识库导入相关内容",
                    "围绕一个更明确的主题继续追问",
                ],
                "mode": "retrieval_only",
                "quality": quality
                or {
                    "level": "none",
                    "label": "未命中知识库",
                    "summary": "当前没有检索到可直接支撑回答的知识库内容。",
                    "recommended_action": "建议先导入相关资料，或缩小问题范围后重试。",
                    "grounded": False,
                    "degraded": True,
                    "citation_count": 0,
                    "matched_items": 0,
                    "top_score": 0.0,
                    "source": "knowledge_base",
                },
            }

        top_matches = matches[:3]
        summary_lines = []
        for item in top_matches:
            title = item.get("title") or "未命名内容"
            summary = item.get("summary") or item.get("snippet") or "当前内容暂无摘要。"
            summary_lines.append(f"《{title}》：{summary}")

        citations = [
            {
                "content_id": item.get("id") or item.get("content_id"),
                "title": item.get("title") or "未命名内容",
                "snippet": item.get("snippet") or item.get("summary") or "",
                "score": float(item.get("score", 0)),
                "platform": item.get("platform"),
                "source_url": item.get("source_url"),
                "start_ms": self._read_chunk_milliseconds(item, "start_ms"),
                "end_ms": self._read_chunk_milliseconds(item, "end_ms"),
                "seek_url": self._read_chunk_seek_url(item),
            }
            for item in top_matches
        ]
        follow_ups = self._build_follow_ups(
            query,
            top_matches,
            query_intent=query_intent,
            quality=quality,
        )
        return {
            "answer": self._build_natural_fallback_answer(query, top_matches, quality or {}),
            "citations": citations,
            "follow_ups": follow_ups,
            "mode": "retrieval_only",
            "quality": quality,
        }

    def _evaluate_quality(
        self,
        matches: list[dict[str, Any]],
        *,
        scoped: bool,
        session_messages: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        if not matches:
            return {
                "level": "none",
                "label": "未命中知识库",
                "summary": "当前没有检索到可直接支撑回答的知识库内容。",
                "recommended_action": "建议先导入相关资料，或把问题缩小到一个更明确的主题。",
                "grounded": False,
                "degraded": True,
                "citation_count": 0,
                "matched_items": 0,
                "top_score": 0.0,
                "source": "knowledge_base",
            }

        top_matches = matches[:4]
        top_score = max(float(item.get("score", 0)) for item in top_matches)
        average_score = sum(float(item.get("score", 0)) for item in top_matches) / len(top_matches)
        citation_count = len(top_matches)
        route_types = {str(item.get("route_type") or "chunk") for item in top_matches}
        session_turns = len(session_messages or [])
        capture_guard = self._build_capture_quality_guard(top_matches, scoped=scoped)
        if capture_guard is not None:
            capture_guard.update(
                {
                    "citation_count": citation_count,
                    "matched_items": len(matches),
                    "top_score": round(top_score, 2),
                    "average_score": round(average_score, 2),
                    "route_count": len(route_types),
                }
            )
            return capture_guard

        strong_score = 12.0 if scoped else 16.0
        medium_score = 6.0 if scoped else 8.0
        weak_score = 3.0 if scoped else 4.0
        content_ids = {
            str(item.get("content_id") or item.get("id") or "").strip()
            for item in top_matches
            if str(item.get("content_id") or item.get("id") or "").strip()
        }
        chunk_scoped = any(item.get("chunk_id") for item in top_matches)

        if scoped and top_score < weak_score and len(content_ids) == 1 and citation_count >= (1 if chunk_scoped else 2):
            return {
                "level": "medium",
                "label": "范围已锁定",
                "summary": "当前问题已经限定在单条内容范围内，即使关键词重合不高，回答也会只基于这条内容的片段和摘要展开。",
                "recommended_action": "如果你要更精确的答案，建议继续指定某个片段、时间点或具体观点。",
                "grounded": True,
                "degraded": False,
                "citation_count": citation_count,
                "matched_items": len(matches),
                "top_score": round(top_score, 2),
                "average_score": round(average_score, 2),
                "route_count": len(route_types),
                "source": "knowledge_base",
            }

        if top_score >= strong_score and len(matches) >= 3 and citation_count >= 3:
            level = "strong"
            label = "依据较强"
            summary = "当前回答基于多条命中内容，引用相对充足，适合继续沿着引用细化判断。"
            action = "建议继续点开引用，确认细节和原始语境。"
        elif top_score >= medium_score and len(matches) >= 2:
            level = "medium"
            label = "依据中等"
            summary = "当前回答有知识库依据，但证据覆盖还不算充分，适合先看结论再回查引用。"
            action = "如果你要拿去直接决策，建议先核对引用片段。"
        elif top_score >= weak_score:
            level = "weak"
            label = "依据偏弱"
            summary = "当前只命中少量或弱相关内容，回答更适合作为线索，不适合直接下确定结论。"
            action = "建议缩小问题范围，或指定某条内容、某个片段继续追问。"
        else:
            level = "weak"
            label = "依据很弱"
            summary = "当前命中的内容过少，且相关度偏低，继续生成确定性回答的风险较高。"
            action = "建议换更具体的问题，或先补充相关资料。"

        if session_turns > 0 and level in {"medium", "strong"}:
            summary += " 本轮还结合了最近会话上下文。"

        return {
            "level": level,
            "label": label,
            "summary": summary,
            "recommended_action": action,
            "grounded": level in {"strong", "medium"},
            "degraded": level == "weak",
            "citation_count": citation_count,
            "matched_items": len(matches),
            "top_score": round(top_score, 2),
            "average_score": round(average_score, 2),
            "route_count": len(route_types),
            "source": "knowledge_base",
        }

    def _build_natural_fallback_answer(
        self,
        query: str,
        matches: list[dict[str, Any]],
        quality: dict[str, Any],
    ) -> str:
        if not matches:
            return "当前还没有拿到足够可用的依据，建议先补充相关内容后再继续追问。"

        if self._query_is_summary_like(query):
            return self._build_summary_like_fallback_answer(query, matches, quality)
        return self._build_direct_fallback_answer(query, matches, quality)

    def _build_summary_like_fallback_answer(
        self,
        query: str,
        matches: list[dict[str, Any]],
        quality: dict[str, Any],
    ) -> str:
        note_match = next(
            (
                item
                for item in matches
                if str(item.get("route_type") or "").strip() in {"note", "content"}
            ),
            matches[0],
        )
        point_limit = self._requested_point_count(query)
        key_points = self._extract_distinct_points_from_matches(matches, limit=point_limit)
        lead = self._resolve_summary_lead(note_match, key_points)
        answer_lines: list[str] = []
        if key_points:
            if point_limit == 1:
                answer_lines.append(f"这条内容里现在最值得先记住的是：{key_points[0]}")
            else:
                answer_lines.append("这条内容更值得先带走的是这几点：")
                answer_lines.append("")
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(key_points, start=1)])
        else:
            answer_lines.append(lead)

        support_glance = self._build_supporting_evidence_glance(matches)
        quality_summary = self._clean_answer_text(str(quality.get("summary") or ""))
        if support_glance:
            answer_lines.extend(
                [
                    "",
                    f"如果你要回看原片或继续核对细节，优先看 {support_glance}。",
                ]
            )
        if quality_summary and quality_summary not in "\n".join(answer_lines):
            answer_lines.extend(["", quality_summary])

        return "\n".join(answer_lines).strip()

    def _build_direct_fallback_answer(
        self,
        query: str,
        matches: list[dict[str, Any]],
        quality: dict[str, Any],
    ) -> str:
        best = matches[0]
        lead = self._clean_answer_text(
            str(
            best.get("snippet")
            or best.get("chunk_summary")
            or best.get("summary")
            or ""
            )
        )
        if not lead:
            lead = "当前已经命中相关内容，但还需要进一步锁定更具体的片段。"

        intent = self._infer_query_intent(query)
        points = self._extract_distinct_points_from_matches(matches, limit=3)
        answer_lines: list[str]

        if intent == "reason":
            answer_lines = [f"目前更稳的判断是：{lead}"]
            reason_points = [item for item in points if item != lead][:2]
            if reason_points:
                answer_lines.extend(["", "支撑这个判断的依据主要有："])
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(reason_points, start=1)])
        elif intent == "action":
            action_points = [item for item in points if item != lead][:3]
            if action_points:
                answer_lines = ["如果现在就往下做，可以先抓这几步：", ""]
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(action_points, start=1)])
            else:
                answer_lines = [lead]
        elif intent == "compare":
            compare_points = points[:3]
            if compare_points:
                answer_lines = ["当前能先确认的差异点主要有：", ""]
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(compare_points, start=1)])
            else:
                answer_lines = [lead]
        elif intent == "decision":
            answer_lines = [f"如果只按当前证据先做判断，更稳妥的结论是：{lead}"]
            decision_points = [item for item in points if item != lead][:2]
            if decision_points:
                answer_lines.extend(["", "你可以优先补看的部分是："])
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(decision_points, start=1)])
        else:
            answer_lines = [lead]
            extra_points = [item for item in points if item != lead][:2]
            if extra_points:
                answer_lines.extend(["", "顺手一起记住这两点会更完整："])
                answer_lines.extend([f"{index}. {item}" for index, item in enumerate(extra_points, start=1)])

        support_glance = self._build_supporting_evidence_glance(matches)
        quality_summary = self._clean_answer_text(str(quality.get("summary") or ""))
        if support_glance:
            answer_lines.extend(
                [
                    "",
                    f"如果继续往下追问，优先回看 {support_glance}，我可以下一轮只围绕那一段继续整理。",
                ]
            )
        elif quality_summary:
            answer_lines.extend(["", quality_summary])

        return "\n".join(answer_lines).strip()

    def _build_agent_upgrade_answer(
        self,
        query: str,
        content: dict[str, Any] | None,
        matches: list[dict[str, Any]],
        quality: dict[str, Any],
    ) -> str:
        title = str((content or {}).get("title") or matches[0].get("title") or "这条内容").strip()
        theme = self._summarize_title_focus(title)
        support_glance = self._build_supporting_evidence_glance(matches)

        lines = [
            "这条内容已经抓到可回看的证据片段，但当前自动整理出来的正文语义还不够稳，我不想把噪声转写直接当成结论复述给你。",
        ]
        if theme:
            lines.append(f"比较稳的主线只能先落在主题层面：它围绕“{theme}”展开。")
        else:
            lines.append(f"比较稳的主线只能先落在主题层面：它围绕《{title}》展开。")
        if support_glance:
            lines.append(f"目前可核对的证据主要落在 {support_glance}。")

        lines.append(
            "更合适的下一步是接入理解模型，把这条内容先重整成可追问的结论、原因和做法；向量检索与时间戳回看会继续保留，专门负责证据核对。"
        )
        return "\n\n".join(lines).strip()

    def _build_weak_evidence_answer(self, query: str, matches: list[dict[str, Any]], quality: dict[str, Any]) -> str:
        evidence_lines: list[str] = []

        for index, item in enumerate(matches[:3], start=1):
            title = item.get("title") or "未命名内容"
            heading = item.get("heading") or f"片段 {index}"
            snippet = item.get("snippet") or item.get("chunk_summary") or item.get("summary") or "暂无可用摘要。"
            evidence_lines.append(f"《{title}》/{heading}：{snippet}")

        return self._format_answer_sections(
            conclusion=f"现在还不适合直接对“{query}”下高确定性结论。",
            status_line=quality.get("summary") or "当前证据还不够稳，先把最接近的线索交给你。",
            evidence_title="当前最接近的线索",
            evidence_lines=evidence_lines,
            next_title="为了拿到更稳的回答，建议下一步",
            next_steps=[
                "指定一条内容或某个片段继续追问。",
                "把问题缩小到一个明确目标，例如只提炼三点方法或只解释某一段。",
                "如果知识库内容太少，先补充 1 到 2 条相关资料再问。",
            ],
        )

    def _build_blocked_source_answer(self, query: str, matches: list[dict[str, Any]], quality: dict[str, Any]) -> str:
        evidence_lines: list[str] = []

        for index, item in enumerate(matches[:3], start=1):
            title = item.get("title") or "未命名内容"
            heading = item.get("heading") or f"片段 {index}"
            snippet = item.get("snippet") or item.get("chunk_summary") or item.get("summary") or "暂无可用摘要。"
            evidence_lines.append(f"《{title}》/{heading}：{snippet}")

        return self._format_answer_sections(
            conclusion=f"这条内容暂时还不能当成一条已经转化完成的知识笔记来回答“{query}”。",
            status_line=quality.get("summary") or "当前命中的内容还停留在基础建档阶段，正文层没有真正补齐。",
            evidence_title="目前只能参考的临时线索",
            evidence_lines=evidence_lines,
            next_title="为了把它变成可检索、可回溯、可问答的笔记，建议下一步",
            next_steps=[
                quality.get("recommended_action") or "先补齐登录态或音频转写能力，再重新解析这条内容。",
                "重新解析后，先检查是否出现原始转写、检索片段和时间定位。",
                "只有在正文层补齐之后，再围绕玩法、机制或结论去做确定性问答。",
            ],
        )

    def _format_answer_sections(
        self,
        *,
        conclusion: str,
        status_line: str | None = None,
        evidence_title: str | None = None,
        evidence_lines: list[str] | None = None,
        next_title: str | None = None,
        next_steps: list[str] | None = None,
    ) -> str:
        lines: list[str] = [conclusion.strip()]

        if status_line and status_line.strip():
            lines.extend(["", status_line.strip()])

        normalized_evidence = [item.strip() for item in (evidence_lines or []) if item and item.strip()]
        if evidence_title and normalized_evidence:
            lines.extend(["", f"{evidence_title.strip()}："])
            lines.extend([f"{index}. {item}" for index, item in enumerate(normalized_evidence, start=1)])

        normalized_steps = [item.strip() for item in (next_steps or []) if item and item.strip()]
        if next_title and normalized_steps:
            lines.extend(["", f"{next_title.strip()}："])
            lines.extend([f"{index}. {item}" for index, item in enumerate(normalized_steps, start=1)])

        return "\n".join(lines).strip()

    def _build_follow_ups(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        query_intent: str | None = None,
        focus_content: dict[str, Any] | None = None,
        focus_context: dict[str, Any] | None = None,
        quality: dict[str, Any] | None = None,
    ) -> list[str]:
        if not matches:
            return []

        first = matches[0]
        query_intent = query_intent or self._infer_query_intent(query)
        quality = quality or {}
        focus_entry = focus_content or first
        title = str((focus_content or {}).get("title") or first.get("title") or "").strip()
        subject = self._build_follow_up_subject(title)
        heading = str(first.get("heading") or "").strip()
        anchor_reference = "当前命中片段" if (first.get("chunk_id") or heading or self._read_chunk_text_field(first, "timestamp_label")) else subject
        note_quality = self._read_note_quality(focus_content) if focus_content is not None else self._extract_note_quality_from_match(first)
        prefers_agent = self._content_prefers_agent(focus_entry)
        blocked = str(quality.get("level") or "").strip() == "blocked"
        degraded = bool(quality.get("degraded"))
        retrieval_ready = bool(note_quality.get("retrieval_ready"))
        question_answer_ready = bool(note_quality.get("question_answer_ready"))
        llm_enhanced = bool(note_quality.get("llm_enhanced"))
        auto_focused = bool((focus_context or {}).get("auto_focused"))
        focus_point = ""
        for candidate in self._extract_distinct_points_from_matches(matches, limit=4):
            cleaned = self._clean_answer_point(candidate)
            if cleaned and len(cleaned) <= 18:
                focus_point = cleaned
                break

        if blocked:
            suggestions = [
                f"先判断{subject}还缺哪一层正文，再给我最短补齐路径",
                f"如果先不追求完整转化，请只围绕{anchor_reference}整理可确认信息",
                f"告诉我怎样检查{subject}已经达到可稳定问答的状态",
            ]
        elif degraded:
            suggestions = [
                "把当前证据分成“能确定 / 待核对 / 先别下结论”三栏",
                f"请只围绕{anchor_reference}继续解释，别扩展到整条内容",
                "告诉我最值得回看的时间段，以及每段该核对什么" if prefers_agent else f"如果继续补证，最该再补哪一条资料来确认{subject}的结论",
            ]
        else:
            if query_intent == "summary":
                suggestions = [
                    f"把{subject}改写成一页复盘框架",
                    "如果只保留最值得带走的三点，分别是什么？",
                    "标出最值得回看的时间段，并说明每段该看什么" if prefers_agent else f"把{subject}再拆成 3 个主题模块重讲一遍",
                ]
            elif query_intent == "reason":
                suggestions = [
                    "把这个判断拆成“结论 / 依据 / 反例”三部分",
                    "如果这个判断不成立，最可能是哪个前提变了？",
                    f"只围绕“{focus_point}”补最关键的判断依据" if focus_point else f"请只围绕{anchor_reference}解释支撑逻辑",
                ]
            elif query_intent == "action":
                suggestions = [
                    f"把{subject}整理成按先后顺序的执行步骤",
                    "如果我是新手，第一步最容易做错的地方是什么？",
                    f"只围绕“{focus_point}”补一版可直接照做的动作清单" if focus_point else f"请只围绕{anchor_reference}继续展开做法",
                ]
            elif query_intent == "compare":
                suggestions = [
                    "把差异整理成对照：对象 / 核心差异 / 适用场景",
                    "如果只能选一个方向，最该先看哪三个判断条件？",
                    f"再单独总结{subject}相对其他内容最突出的特点" if auto_focused and subject != "这条内容" else "把相同点和不同点分别列出来",
                ]
            elif query_intent == "decision":
                suggestions = [
                    "把当前结论分成“能确定 / 需补证 / 暂不建议”三部分",
                    "如果现在就要做选择，最该先确认哪三个条件？",
                    f"只围绕“{focus_point}”判断它对最终选择的影响" if focus_point else f"请只围绕{anchor_reference}补最影响决策的一段证据",
                ]
            else:
                suggestions = [
                    f"把{subject}讲成一版适合新手快速理解的说明",
                    "如果继续往下追问，最应该先展开哪一部分？",
                    f"只围绕“{focus_point}”继续展开，别扩到其他部分" if focus_point else f"请只围绕{anchor_reference}继续展开",
                ]

        if prefers_agent and not blocked and not degraded:
            suggestions.append("告诉我最值得回看的时间段，以及为什么是那几段")
        if prefers_agent and retrieval_ready and not llm_enhanced and not blocked:
            suggestions.append(f"先把{subject}改写成“结论 / 原因 / 做法”三段式")
        if retrieval_ready and not question_answer_ready and not blocked:
            suggestions.append("先做一版可核对摘要，再继续追问结论")
        if heading and not blocked:
            suggestions.append("请只围绕当前命中片段继续追问")

        deduped: list[str] = []
        for item in suggestions:
            cleaned = item.strip()
            signature = re.sub(r"[^\w\u4e00-\u9fff]+", "", cleaned.lower())
            if cleaned and signature and signature not in {
                re.sub(r"[^\w\u4e00-\u9fff]+", "", existing.lower()) for existing in deduped
            }:
                deduped.append(cleaned)
        return deduped[:3]

    def _build_follow_up_subject(self, title: str) -> str:
        cleaned = self._summarize_title_focus(title)
        if cleaned and len(cleaned) <= 22:
            return f"《{cleaned}》"
        return "这条内容"

    def _extract_note_quality_from_match(self, item: dict[str, Any]) -> dict[str, Any]:
        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            return {}
        note_quality = metadata.get("note_quality")
        return note_quality if isinstance(note_quality, dict) else {}

    def _polish_generated_answer(self, text: str) -> str:
        candidate = str(text or "").strip()
        if not candidate:
            return ""

        if candidate.startswith("```"):
            candidate = candidate.strip("`")
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()

        candidate = candidate.replace("\r", "")
        normalized_lines: list[str] = []
        for raw_line in candidate.split("\n"):
            line = raw_line.strip()
            if re.match(r"^#{1,6}\s+", line):
                line = re.sub(r"^#{1,6}\s+", "", line).strip()
            if self._is_standalone_answer_heading(line):
                continue
            if not line:
                if normalized_lines and normalized_lines[-1] != "":
                    normalized_lines.append("")
                continue
            normalized_lines.append(self._normalize_generated_line(line))

        paragraphs: list[str] = []
        buffer: list[str] = []
        for line in [*normalized_lines, ""]:
            if line == "":
                if buffer:
                    paragraph = " ".join(buffer).strip()
                    paragraph = self._dedupe_repetitive_sentences(paragraph)
                    if paragraph:
                        paragraphs.append(paragraph)
                    buffer = []
                continue
            list_match = re.match(r"^(?:[-*•]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+(.*)$", line)
            if list_match:
                if buffer:
                    paragraph = " ".join(buffer).strip()
                    paragraph = self._dedupe_repetitive_sentences(paragraph)
                    if paragraph:
                        paragraphs.append(paragraph)
                    buffer = []
                paragraphs.append(f"- {self._clean_answer_text(list_match.group(1))}")
                continue
            buffer.append(line)

        deduped: list[str] = []
        signatures: list[str] = []
        for paragraph in paragraphs:
            signature = re.sub(r"[^\w\u4e00-\u9fff]+", "", paragraph.lower())
            if not signature:
                continue
            if any(self._paragraph_signatures_overlap(signature, existing) for existing in signatures):
                continue
            signatures.append(signature)
            deduped.append(paragraph)

        cleaned = "\n\n".join(deduped).strip()
        cleaned = re.sub(r"(?:\n\s*){3,}", "\n\n", cleaned)
        return cleaned or self._clean_answer_text(candidate)

    def _normalize_generated_line(self, line: str) -> str:
        cleaned = self._clean_answer_text(line)
        cleaned = re.sub(r"^(?:根据资料|基于资料|从资料来看|从内容来看|基于这条内容|整体来看|总的来说)[，,：:\s]*", "", cleaned)
        cleaned = re.sub(r"^(?:先直接回答你这句|先说结论|直接说结论)[：:\s]*", "", cleaned)
        cleaned = re.sub(r"^(?:如果只看结论|如果只保留一句话|简单说|更直接一点说|换句话说)[，,：:\s]*", "", cleaned)
        cleaned = cleaned.replace("……", "。")
        cleaned = re.sub(r"\.{3,}", "。", cleaned)
        return cleaned.strip()

    def _dedupe_repetitive_sentences(self, paragraph: str) -> str:
        sentences = [item.strip() for item in re.split(r"(?<=[。！？；!?;])\s*", paragraph) if item.strip()]
        if len(sentences) <= 1:
            return paragraph.strip()

        deduped: list[str] = []
        seen: set[str] = set()
        seen_signatures: list[str] = []
        for sentence in sentences:
            signature = re.sub(r"[^\w\u4e00-\u9fff]+", "", sentence.lower())
            if not signature or signature in seen:
                continue
            if any(self._text_signatures_similar(signature, existing) for existing in seen_signatures):
                continue
            seen.add(signature)
            seen_signatures.append(signature)
            deduped.append(sentence)
        return " ".join(deduped).strip()

    def _paragraph_signatures_overlap(self, current: str, existing: str) -> bool:
        if not current or not existing:
            return False
        if current == existing or current in existing or existing in current:
            return True
        prefix_length = min(len(current), len(existing), 42)
        if prefix_length >= 18 and current[:prefix_length] == existing[:prefix_length]:
            return True
        if self._text_signatures_similar(current, existing):
            return True
        return False

    def _text_signatures_similar(self, current: str, existing: str) -> bool:
        if not current or not existing:
            return False
        current_tokens = self._build_similarity_tokens(current)
        existing_tokens = self._build_similarity_tokens(existing)
        if not current_tokens or not existing_tokens:
            return False
        overlap = len(current_tokens & existing_tokens)
        baseline = min(len(current_tokens), len(existing_tokens))
        if baseline <= 0:
            return False
        return (overlap / baseline) >= 0.76

    def _build_similarity_tokens(self, text: str) -> set[str]:
        normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", text.lower())
        if not normalized:
            return set()
        if len(normalized) <= 4:
            return {normalized}
        return {normalized[index:index + 2] for index in range(len(normalized) - 1)}

    def _is_standalone_answer_heading(self, line: str) -> bool:
        normalized = line.strip().replace("：", "").replace(":", "")
        return normalized in {
            "结论",
            "当前判断",
            "优先可参考的内容",
            "优先可参考的结论",
            "当前最接近的线索",
            "目前只能参考的临时线索",
            "建议下一步",
            "通用回答",
            "如果你想让后续回答更贴近你的资料",
        }

    def _requested_point_count(self, query: str) -> int:
        normalized = re.sub(r"\s+", "", query or "")
        match = re.search(r"([1234一二两三四])(?:个|条|点|项)?(?:结论|重点|要点|信息)", normalized)
        if not match:
            return 3
        mapping = {
            "1": 1,
            "2": 2,
            "3": 3,
            "4": 4,
            "一": 1,
            "二": 2,
            "两": 2,
            "三": 3,
            "四": 4,
        }
        return max(1, min(4, mapping.get(match.group(1), 3)))

    def _extract_match_key_points(self, item: dict[str, Any]) -> list[str]:
        raw_key_points = item.get("key_points")
        if isinstance(raw_key_points, list):
            normalized = [
                self._clean_answer_point(str(entry))
                for entry in raw_key_points
                if self._clean_answer_point(str(entry))
            ]
            if normalized:
                return normalized[:5]

        source = str(item.get("refined_note") or item.get("chunk_text") or "").strip()
        if not source:
            return []

        ignored_titles = {
            "核心结论",
            "快速摘要",
            "问题结论",
            "一句话总结",
            "内容结构",
            "重点摘录",
            "关键答案",
            "对用户有用的信息",
            "可直接参考的信息",
            "精炼正文",
            "回答整理",
            "实用整理",
            "正文整理",
            "视频笔记",
            "速记内容",
            "可执行建议",
            "下一步建议",
            "原始信息保留",
        }
        candidates: list[str] = []
        for raw_line in source.splitlines():
            line = re.sub(r"^#+\s*", "", raw_line).strip()
            line = re.sub(r"^(?:[-*•]|\d+\.)\s+", "", line).strip()
            if not line or line in ignored_titles:
                continue
            line = self._clean_answer_point(line)
            if not line:
                continue
            if len(line) < 4:
                continue
            if line not in candidates:
                candidates.append(line)
        return candidates[:5]

    def _extract_distinct_points_from_matches(
        self,
        matches: list[dict[str, Any]],
        *,
        limit: int,
    ) -> list[str]:
        points: list[str] = []
        signatures: list[str] = []

        for item in matches:
            local_candidates = [
                *self._extract_match_key_points(item),
                self._clean_answer_point(str(item.get("snippet") or "")),
                self._clean_answer_point(str(item.get("chunk_summary") or "")),
                self._clean_answer_point(str(item.get("summary") or "")),
            ]
            for candidate in local_candidates:
                cleaned = self._clean_answer_point(candidate)
                if not cleaned:
                    continue
                signature = re.sub(r"[^\w\u4e00-\u9fff]+", "", cleaned.lower())
                if len(signature) < 6:
                    continue
                if any(signature == existing or signature in existing or existing in signature for existing in signatures):
                    continue
                signatures.append(signature)
                points.append(cleaned)
                if len(points) >= limit:
                    return points[:limit]

        return points[:limit]

    def _infer_query_intent(self, query: str) -> str:
        normalized = re.sub(r"\s+", "", query or "")
        if self._query_is_summary_like(query):
            return "summary"
        if any(marker in normalized for marker in ("对比", "区别", "差异", "不同", "优缺点", "哪个更")):
            return "compare"
        if any(marker in normalized for marker in ("为什么", "原因", "逻辑", "怎么判断")):
            return "reason"
        if any(marker in normalized for marker in ("如何", "怎么做", "步骤", "做法", "上手", "执行", "落地", "操作")):
            return "action"
        if any(marker in normalized for marker in ("要不要", "值不值得", "该不该", "适不适合", "能不能", "选哪个", "能买吗")):
            return "decision"
        return "explain"

    def _resolve_summary_lead(self, item: dict[str, Any], key_points: list[str]) -> str:
        if key_points:
            return key_points[0]

        candidates = [
            item.get("summary"),
            item.get("snippet"),
            item.get("chunk_summary"),
            item.get("chunk_text"),
        ]
        for candidate in candidates:
            cleaned = self._clean_answer_text(str(candidate or ""))
            if cleaned:
                return cleaned
        return "当前已经命中相关内容，但还需要继续围绕片段和细节来做整理。"

    def _clean_answer_point(self, value: str) -> str:
        cleaned = self._clean_answer_text(value)
        if not cleaned:
            return ""

        punctuation_match = re.search(r"[。！？；;]", cleaned)
        if punctuation_match and punctuation_match.start() >= 8:
            return cleaned[:punctuation_match.start()].strip()

        comma_match = re.search(r"[，,]", cleaned)
        if comma_match and comma_match.start() >= 10:
            return cleaned[:comma_match.start()].strip()

        if len(cleaned) <= 72:
            return cleaned
        return cleaned[:72].rstrip()

    def _clean_answer_text(self, value: str) -> str:
        cleaned = str(value or "").strip()
        if not cleaned:
            return ""

        cleaned = re.sub(r"\s+", " ", cleaned)
        cleaned = re.sub(r"(?:\.{3,}|…+)\s*$", "", cleaned)
        cleaned = re.sub(r"^[：:;；，,。\-\s]+", "", cleaned)
        return cleaned.strip()

    def _build_supporting_evidence_glance(self, matches: list[dict[str, Any]]) -> str:
        labels: list[str] = []
        for item in matches:
            route_type = str(item.get("route_type") or "chunk").strip()
            if route_type == "note":
                label = "精炼笔记层"
            else:
                label = self._describe_match_anchor(item)
            if label and label not in labels:
                labels.append(label)

        if not labels:
            return ""
        if len(labels) == 1:
            return labels[0]
        if len(labels) == 2:
            return f"{labels[0]} 和 {labels[1]}"
        return "、".join(labels[:3])

    def _describe_match_anchor(self, item: dict[str, Any]) -> str:
        timestamp_label = self._read_chunk_text_field(item, "timestamp_label")
        if timestamp_label:
            return timestamp_label

        heading = str(item.get("heading") or "").strip()
        title = str(item.get("title") or "这条内容").strip()
        if heading and heading != "精炼笔记":
            return f"《{title}》的“{heading}”"
        return f"《{title}》"

    def _build_heuristic_variants(self, query: str) -> list[str]:
        lowered = query.strip()
        normalized = re.sub(r"[？?。！!，,；;：:]+", " ", lowered)
        normalized = re.sub(r"\s+", " ", normalized).strip()
        variants: list[str] = []

        stripped = normalized
        filler_patterns = [
            r"^(我想|我需要|请问|帮我|请帮我|我准备|我正在|我现在|能不能|如何|怎么|为什么|请你)\s*",
            r"\s*(讲讲|解释一下|总结一下|分析一下|告诉我|给我|做个总结|做一份总结)$",
        ]
        for pattern in filler_patterns:
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

        compact_terms = []
        for token in [*latin_terms, *han_blocks]:
            cleaned = token.strip()
            if len(cleaned) >= 2 and cleaned not in compact_terms:
                compact_terms.append(cleaned)
        if compact_terms:
            variants.append(" ".join(compact_terms[:4]))

        deduped: list[str] = []
        for item in variants:
            cleaned = item.strip()
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:4]

    def _resolve_answer_strategy(
        self,
        content: dict[str, Any] | None,
        quality: dict[str, Any],
        *,
        focus_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        note_quality = self._read_note_quality(content)
        semantic_score_raw = note_quality.get("semantic_score", quality.get("semantic_score", 0))
        try:
            semantic_score = float(semantic_score_raw or 0)
        except (TypeError, ValueError):
            semantic_score = 0.0

        prefers_agent = self._content_prefers_agent(content)
        llm_available = bool(self.llm_gateway is not None and self.llm_gateway.is_enabled())
        llm_enhanced = bool(note_quality.get("llm_enhanced"))
        needs_model = prefers_agent and semantic_score < 68 and not llm_enhanced
        focus_mode = str((focus_context or {}).get("focus_mode") or "").strip()
        return {
            "mode": "agent_focus" if prefers_agent and focus_mode == "auto" else "agent_hybrid" if prefers_agent else "precision_rag",
            "prefers_agent": prefers_agent,
            "llm_available": llm_available,
            "llm_recommended": prefers_agent,
            "needs_model": needs_model and not llm_available,
            "semantic_score": round(semantic_score, 2),
            "quality_summary": str(note_quality.get("summary") or "").strip(),
            "recommended_action": str(note_quality.get("recommended_action") or "").strip(),
        }

    def _resolve_focus_content_context(
        self,
        *,
        repository: Any,
        query: str,
        matches: list[dict[str, Any]],
        scoped_content: dict[str, Any] | None,
        scoped: bool,
    ) -> dict[str, Any]:
        if scoped_content is not None:
            content_id = str(scoped_content.get("id") or "").strip()
            title = str(scoped_content.get("title") or "").strip()
            return {
                "content": scoped_content,
                "content_id": content_id,
                "title": title,
                "focus_mode": "scoped",
                "auto_focused": False,
                "matched_count": len(
                    [
                        item
                        for item in matches[:5]
                        if str(item.get("content_id") or item.get("id") or "").strip() == content_id
                    ]
                ),
                "score_share": 1.0 if matches else 0.0,
            }

        if scoped or not matches:
            return {
                "content": None,
                "content_id": "",
                "title": "",
                "focus_mode": "mixed",
                "auto_focused": False,
                "matched_count": 0,
                "score_share": 0.0,
            }

        top_matches = matches[:5]
        weighted_scores: dict[str, float] = {}
        content_counts: dict[str, int] = {}
        content_titles: dict[str, str] = {}

        for item in top_matches:
            content_id = str(item.get("content_id") or item.get("id") or "").strip()
            if not content_id:
                continue
            route_type = str(item.get("route_type") or "chunk").strip()
            weight = max(0.25, float(item.get("score", 0)))
            if route_type == "note":
                weight += 2.4
            elif route_type == "content":
                weight += 1.1
            weighted_scores[content_id] = weighted_scores.get(content_id, 0.0) + weight
            content_counts[content_id] = content_counts.get(content_id, 0) + 1
            if content_id not in content_titles:
                content_titles[content_id] = str(item.get("title") or "").strip()

        if not weighted_scores:
            return {
                "content": None,
                "content_id": "",
                "title": "",
                "focus_mode": "mixed",
                "auto_focused": False,
                "matched_count": 0,
                "score_share": 0.0,
            }

        query_intent = self._infer_query_intent(query)
        if query_intent == "compare" and len(weighted_scores) > 1:
            return {
                "content": None,
                "content_id": "",
                "title": "",
                "focus_mode": "mixed",
                "auto_focused": False,
                "matched_count": 0,
                "score_share": 0.0,
            }

        total_weight = sum(weighted_scores.values())
        dominant_content_id = max(weighted_scores, key=weighted_scores.get)
        dominant_hits = content_counts.get(dominant_content_id, 0)
        score_share = weighted_scores[dominant_content_id] / max(total_weight, 0.0001)
        first_content_id = str(top_matches[0].get("content_id") or top_matches[0].get("id") or "").strip()
        second_content_id = str(top_matches[1].get("content_id") or top_matches[1].get("id") or "").strip() if len(top_matches) > 1 else ""
        leading_pair_same = bool(first_content_id and first_content_id == second_content_id == dominant_content_id)
        summary_like = self._query_is_summary_like(query)
        should_focus = (
            dominant_hits >= 3
            or (dominant_hits >= 2 and score_share >= 0.56)
            or (leading_pair_same and score_share >= 0.68)
            or (summary_like and dominant_hits >= 2 and score_share >= 0.5)
        )
        if not should_focus:
            return {
                "content": None,
                "content_id": "",
                "title": "",
                "focus_mode": "mixed",
                "auto_focused": False,
                "matched_count": dominant_hits,
                "score_share": round(score_share, 2),
            }

        focused_content = repository.get_content(dominant_content_id)
        if focused_content is None:
            return {
                "content": None,
                "content_id": dominant_content_id,
                "title": content_titles.get(dominant_content_id, ""),
                "focus_mode": "mixed",
                "auto_focused": False,
                "matched_count": dominant_hits,
                "score_share": round(score_share, 2),
            }

        return {
            "content": focused_content,
            "content_id": dominant_content_id,
            "title": str(focused_content.get("title") or content_titles.get(dominant_content_id, "")).strip(),
            "focus_mode": "auto",
            "auto_focused": True,
            "matched_count": dominant_hits,
            "score_share": round(score_share, 2),
        }

    def _build_answer_strategy_summary(
        self,
        answer_strategy: dict[str, Any],
        focus_context: dict[str, Any] | None,
        quality: dict[str, Any],
    ) -> str:
        existing_summary = str(quality.get("summary") or "").strip()
        focus_title = str((focus_context or {}).get("title") or "").strip()
        focus_mode = str((focus_context or {}).get("focus_mode") or "").strip()

        if answer_strategy.get("prefers_agent"):
            if answer_strategy.get("llm_available") and focus_title:
                base_summary = "当前会先按整条内容理解，再回到命中片段做证据核对。"
            elif answer_strategy.get("needs_model"):
                base_summary = "这类内容更适合先走理解模型整理，再结合片段回看确认。"
            else:
                base_summary = "这类内容更适合以整条内容为主线，再用命中片段补证。"
        else:
            base_summary = "当前会先融合命中片段，再做归纳整理。"

        if focus_mode == "scoped" and focus_title:
            lead_summary = f"本轮已锁定《{focus_title}》。"
        elif bool((focus_context or {}).get("auto_focused")) and focus_title:
            lead_summary = f"本轮已自动聚焦《{focus_title}》。"
        else:
            lead_summary = ""

        parts = [lead_summary, base_summary]
        content_quality_summary = str(answer_strategy.get("quality_summary") or "").strip()
        if quality.get("degraded"):
            degraded_summary = content_quality_summary or existing_summary
            if degraded_summary:
                parts.append(degraded_summary)

        merged = " ".join(part.strip() for part in parts if part and part.strip()).strip()
        return merged or existing_summary

    def _content_prefers_agent(self, content: dict[str, Any] | None) -> bool:
        if content is None:
            return False
        platform = str(content.get("platform") or "").strip().lower()
        source_type = str(content.get("source_type") or "").strip().lower()
        content_type = str(content.get("content_type") or "").strip().lower()
        if platform == "bilibili" or content_type == "video":
            return True
        if platform == "webpage" and source_type == "url":
            return True
        return False

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
        recent_user_messages = payload.get("recent_user_queries") if isinstance(payload.get("recent_user_queries"), list) else []
        last_user_query = str(payload.get("last_user_query") or "").strip()
        lead_title = str(payload.get("lead_title") or "").strip()
        assistant_focus = str(payload.get("assistant_focus") or "").strip()
        current_query = str(query or "").strip()

        combined_candidates = [
            self._merge_query_with_context(current_query, lead_title),
            self._merge_query_with_context(current_query, last_user_query),
            self._merge_query_with_context(current_query, assistant_focus),
        ]
        for candidate in combined_candidates:
            if candidate and candidate not in variants:
                variants.append(candidate)

        for message in recent_user_messages[-2:]:
            normalized = re.sub(r"\s+", " ", str(message or "")).strip()
            if normalized and normalized not in variants:
                variants.append(normalized)

            han_blocks = re.findall(r"[\u4e00-\u9fff]{2,12}", normalized)
            latin_terms = re.findall(r"[A-Za-z][A-Za-z0-9_\-]{1,24}", normalized)
            merged = " ".join([*(han_blocks[:2]), *(latin_terms[:2])]).strip()
            if merged and merged not in variants:
                variants.append(merged)

        for item in [lead_title, assistant_focus]:
            cleaned = item.strip()
            if cleaned and cleaned not in variants:
                variants.append(cleaned)

        deduped: list[str] = []
        for item in variants:
            cleaned = item.strip()
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:4]

    def _build_session_context_payload(self, session_messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not session_messages:
            return {}

        recent_messages = session_messages[-6:]
        # 截断每条消息正文，防止长对话过度消耗 context
        _MSG_LIMIT = 200
        truncated_messages = [
            {**item, "message_text": str(item.get("message_text") or "")[:_MSG_LIMIT]}
            for item in recent_messages
        ]
        recent_user_queries = [
            str(item.get("message_text") or "").strip()
            for item in truncated_messages
            if item.get("role") == "user" and str(item.get("message_text") or "").strip()
        ]
        recent_assistant_messages = [
            item
            for item in truncated_messages
            if item.get("role") == "assistant" and str(item.get("message_text") or "").strip()
        ]
        if not recent_user_queries and not recent_assistant_messages:
            return {}

        citation_titles: list[str] = []
        for item in reversed(recent_assistant_messages):
            citations = item.get("citations")
            if not isinstance(citations, list):
                continue
            for citation in citations:
                if not isinstance(citation, dict):
                    continue
                title = str(citation.get("title") or "").strip()
                if title and title not in citation_titles:
                    citation_titles.append(title)

        text_titles: list[str] = []
        for item in recent_messages:
            text = str(item.get("message_text") or "").strip()
            if not text:
                continue
            for title in re.findall(r"《([^》]{2,40})》", text):
                cleaned = title.strip()
                if cleaned and cleaned not in text_titles:
                    text_titles.append(cleaned)

        lead_title = citation_titles[0] if citation_titles else text_titles[0] if text_titles else ""
        latest_assistant_text = str(recent_assistant_messages[-1].get("message_text") or "").strip() if recent_assistant_messages else ""
        assistant_focus = self._extract_context_focus_text(latest_assistant_text)

        return {
            "recent_user_queries": recent_user_queries[-2:],
            "last_user_query": recent_user_queries[-1] if recent_user_queries else "",
            "lead_title": lead_title,
            "assistant_focus": assistant_focus,
            "citation_titles": citation_titles[:3],
        }

    def _merge_query_with_context(self, query: str, context: str) -> str:
        cleaned_query = re.sub(r"\s+", " ", query or "").strip()
        cleaned_context = re.sub(r"\s+", " ", context or "").strip()
        if not cleaned_query or not cleaned_context:
            return ""
        if cleaned_context in cleaned_query or cleaned_query in cleaned_context:
            return cleaned_query if len(cleaned_query) >= len(cleaned_context) else cleaned_context
        if len(cleaned_context) > 36:
            cleaned_context = cleaned_context[:36].rstrip()
        return f"{cleaned_context} {cleaned_query}".strip()

    def _extract_context_focus_text(self, text: str) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip()
        if not cleaned:
            return ""
        cleaned = re.sub(r"^(?:结论|当前判断|优先可参考的结论|建议下一步)[：:\s]*", "", cleaned)
        for sentence in re.split(r"(?<=[。！？!?；;])\s*", cleaned):
            candidate = sentence.strip()
            if len(candidate) >= 8:
                return candidate[:48].rstrip()
        return cleaned[:48].rstrip()

    def _query_needs_context(self, query: str) -> bool:
        normalized = re.sub(r"\s+", "", query or "")
        if not normalized:
            return False
        reference_markers = (
            "这篇",
            "这个",
            "这条",
            "这里",
            "它",
            "上面",
            "前面",
            "刚才",
            "继续",
            "展开",
            "详细说",
            "细讲",
            "这部分",
            "这一段",
            "这个点",
            "然后",
            "那么",
            "本文",
            "该文",
            "该视频",
            "这视频",
        )
        return len(normalized) <= 12 or any(marker in normalized for marker in reference_markers)

    def _reshape_matches_for_query(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        scoped: bool,
        limit: int,
    ) -> list[dict[str, Any]]:
        if not matches:
            return []

        deduped = self._dedupe_similar_matches(matches)
        if not self._query_is_summary_like(query):
            return deduped[:limit]

        note_matches = [
            item for item in deduped if str(item.get("route_type") or "").strip() == "note"
        ]
        non_note_matches = [
            item for item in deduped if str(item.get("route_type") or "").strip() != "note"
        ]

        result: list[dict[str, Any]] = []
        if note_matches:
            result.extend(sorted(note_matches, key=lambda item: float(item.get("score", 0)), reverse=True)[:1])

        per_content_counts: dict[str, int] = {}
        per_content_cap = 2 if scoped else 1
        for item in sorted(non_note_matches, key=lambda row: float(row.get("score", 0)), reverse=True):
            content_key = str(item.get("content_id") or item.get("id") or "").strip()
            if content_key and per_content_counts.get(content_key, 0) >= per_content_cap:
                continue
            result.append(item)
            if content_key:
                per_content_counts[content_key] = per_content_counts.get(content_key, 0) + 1
            if len(result) >= limit:
                return result[:limit]

        for item in deduped:
            if item in result:
                continue
            result.append(item)
            if len(result) >= limit:
                break

        return result[:limit]

    def _dedupe_similar_matches(self, matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
        deduped: list[dict[str, Any]] = []
        signatures: list[dict[str, Any]] = []

        for item in sorted(matches, key=lambda row: float(row.get("score", 0)), reverse=True):
            signature = self._build_match_signature(item)
            if any(self._match_signatures_overlap(signature, existing) for existing in signatures):
                continue
            deduped.append(item)
            signatures.append(signature)

        return deduped

    def _build_match_signature(self, item: dict[str, Any]) -> dict[str, Any]:
        snippet = str(
            item.get("snippet")
            or item.get("chunk_summary")
            or item.get("summary")
            or item.get("chunk_text")
            or ""
        ).strip()
        start_ms = self._read_chunk_milliseconds(item, "start_ms")
        return {
            "content_id": str(item.get("content_id") or item.get("id") or "").strip(),
            "route_type": str(item.get("route_type") or "chunk").strip(),
            "heading": str(item.get("heading") or "").strip().lower(),
            "text": self._normalize_signature_text(snippet),
            "time_bucket": start_ms // 15000 if start_ms is not None else None,
        }

    def _match_signatures_overlap(self, current: dict[str, Any], existing: dict[str, Any]) -> bool:
        if current["content_id"] != existing["content_id"]:
            return False
        if current["route_type"] == existing["route_type"] == "note":
            return True
        if current["heading"] and current["heading"] == existing["heading"]:
            if current["time_bucket"] is None or current["time_bucket"] == existing["time_bucket"]:
                return True
        if current["text"] and existing["text"]:
            prefix_length = min(len(current["text"]), len(existing["text"]), 42)
            if prefix_length >= 18 and current["text"][:prefix_length] == existing["text"][:prefix_length]:
                return True
        return False

    def _normalize_signature_text(self, text: str) -> str:
        normalized = re.sub(r"\s+", "", text.lower())
        normalized = re.sub(r"[^\w\u4e00-\u9fff]+", "", normalized)
        return normalized[:96]

    def _build_scoped_note_snippet(
        self,
        query: str,
        *,
        summary: str,
        key_points: list[str],
        refined_note: str,
    ) -> str:
        snippet_candidates = [summary, *key_points[:3]]
        for candidate in snippet_candidates:
            cleaned = candidate.strip()
            if cleaned:
                return cleaned[:180] + ("..." if len(cleaned) > 180 else "")

        source = refined_note.strip()
        if not source:
            return ""
        if query:
            lowered = source.lower()
            index = lowered.find(query.lower())
            if index >= 0:
                start = max(0, index - 50)
                end = min(len(source), index + 130)
                snippet = source[start:end].strip()
                prefix = "..." if start > 0 else ""
                suffix = "..." if end < len(source) else ""
                return f"{prefix}{snippet}{suffix}"
        return source[:180] + ("..." if len(source) > 180 else "")

    def _build_content_term_variants(self, content: dict[str, Any], query: str) -> list[str]:
        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        term_payload = metadata.get("content_terms") if isinstance(metadata.get("content_terms"), dict) else {}
        primary_terms = [
            str(item).strip()
            for item in (term_payload.get("primary_terms") or [])
            if str(item).strip()
        ]
        title_terms = [
            str(item).strip()
            for item in (term_payload.get("title_terms") or [])
            if str(item).strip()
        ]
        tag_terms = [
            str(item).strip()
            for item in (term_payload.get("tag_terms") or [])
            if str(item).strip()
        ]
        topic_query = str(term_payload.get("topic_query") or "").strip()

        variants: list[str] = []
        if self._query_is_summary_like(query):
            for candidate in [topic_query, " ".join(title_terms[:3]).strip(), " ".join(primary_terms[:4]).strip()]:
                if candidate:
                    variants.append(candidate)
        else:
            compact = " ".join(primary_terms[:3]).strip()
            if compact:
                variants.append(compact)
            title_compact = " ".join(title_terms[:2]).strip()
            if title_compact:
                variants.append(title_compact)

        if tag_terms:
            variants.append(" ".join(tag_terms[:3]))

        deduped: list[str] = []
        for item in variants:
            cleaned = item.strip()
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:3]

    def _query_is_summary_like(self, query: str) -> bool:
        normalized = re.sub(r"\s+", "", query or "")
        summary_markers = (
            "概括",
            "总结",
            "梳理",
            "提炼",
            "讲了什么",
            "说了什么",
            "主要内容",
            "核心内容",
            "重点",
            "结论",
            "值得记住",
            "复盘",
        )
        return any(marker in normalized for marker in summary_markers)

    def _route_boost(self, route_type: str, variant_index: int, rank: int) -> float:
        route_base = 1.8 if route_type == "chunk" else 0.9
        variant_bonus = max(0.0, 1.0 - variant_index * 0.18)
        rank_bonus = max(0.0, 0.8 - rank * 0.08)
        return route_base + variant_bonus + rank_bonus

    def _apply_quality_boost(self, item: dict[str, Any], *, base_score: float) -> float:
        metadata = item.get("metadata")
        metadata_dict = metadata if isinstance(metadata, dict) else {}
        note_quality = metadata_dict.get("note_quality")
        note_quality_dict = note_quality if isinstance(note_quality, dict) else {}

        score = base_score
        quality_boost = 0.0

        quality_score_raw = note_quality_dict.get("sort_score", note_quality_dict.get("score"))
        try:
            quality_score = float(quality_score_raw)
        except (TypeError, ValueError):
            quality_score = 0.0

        if quality_score > 0:
            quality_boost += min(1.4, max(0.0, quality_score / 100.0) * 1.4)

        if note_quality_dict.get("question_answer_ready") is True:
            quality_boost += 0.9
        elif note_quality_dict.get("retrieval_ready") is True:
            quality_boost += 0.45

        if note_quality_dict.get("time_jump_ready") is True:
            quality_boost += 0.22

        capture_status = str(
            item.get("status")
            or note_quality_dict.get("capture_status")
            or metadata_dict.get("capture_status")
            or ""
        ).strip()
        status_boosts = {
            "ready": 0.62,
            "ready_estimated": 0.28,
            "limited": -0.25,
            "needs_cookie": -0.85,
            "needs_asr": -0.75,
            "asr_failed": -1.0,
            "preview_ready": -1.15,
        }
        quality_boost += status_boosts.get(capture_status, 0.0)

        item["base_score"] = round(base_score, 2)
        item["quality_boost"] = round(quality_boost, 2)
        score += quality_boost
        return round(score, 4)

    def _read_note_quality(self, content: dict[str, Any] | None) -> dict[str, Any]:
        if content is None:
            return {}
        metadata = content.get("metadata")
        if not isinstance(metadata, dict):
            return {}
        note_quality = metadata.get("note_quality")
        if isinstance(note_quality, dict) and "semantic_score" in note_quality and "agent_ready" in note_quality:
            return note_quality

        try:
            reevaluated = self.note_quality_service.evaluate(content)
        except Exception:
            return note_quality if isinstance(note_quality, dict) else {}

        if not isinstance(note_quality, dict):
            return reevaluated

        merged = dict(note_quality)
        for key in (
            "score",
            "level",
            "label",
            "summary",
            "recommended_action",
            "question_answer_ready",
            "semantic_score",
            "agent_ready",
            "llm_enhanced",
            "dimensions",
            "sort_score",
        ):
            if key in reevaluated:
                merged[key] = reevaluated[key]
        return merged

    def _build_capture_quality_guard(self, matches: list[dict[str, Any]], *, scoped: bool) -> dict[str, Any] | None:
        blocked_statuses = {"needs_cookie", "needs_asr", "asr_failed", "limited"}
        capture_infos = [self._extract_capture_info(item) for item in matches]
        blocked_infos = [item for item in capture_infos if item["status"] in blocked_statuses]
        ready_infos = [item for item in capture_infos if item["status"] in {"ready", "ready_estimated"}]

        if not blocked_infos:
            return None

        # Scoped问答时，如果命中的内容本身还没完成转化，优先明确告诉用户先补齐采集层。
        if scoped and not ready_infos:
            primary = blocked_infos[0]
            return {
                "level": "blocked",
                "label": "来源待补全",
                "summary": primary["summary"] or "当前命中的内容还没有形成完整正文层，继续给确定性答案的风险较高。",
                "recommended_action": primary["action"] or "请先补齐登录态或音频转写能力，再重新解析这条内容。",
                "grounded": False,
                "degraded": True,
                "source": "content_capture",
                "blocked_reason": primary["reason"],
            }

        # 全库问答时，只有在顶部命中几乎都来自半成品内容时，才进入这条保护逻辑。
        if len(blocked_infos) == len(capture_infos) and not ready_infos:
            primary = blocked_infos[0]
            return {
                "level": "blocked",
                "label": "命中内容待补全",
                "summary": primary["summary"] or "当前命中的内容大多还没有形成完整正文层，继续给确定性答案的风险较高。",
                "recommended_action": primary["action"] or "请先补齐登录态或音频转写能力，再重新解析相关内容。",
                "grounded": False,
                "degraded": True,
                "source": "content_capture",
                "blocked_reason": primary["reason"],
            }

        return None

    def _extract_capture_info(self, item: dict[str, Any]) -> dict[str, str]:
        metadata = item.get("metadata")
        metadata_dict = metadata if isinstance(metadata, dict) else {}
        status = str(item.get("status") or metadata_dict.get("capture_status") or "").strip()
        summary = str(metadata_dict.get("capture_summary") or "").strip()
        action = str(metadata_dict.get("capture_recommended_action") or "").strip()
        reason = str(metadata_dict.get("capture_blocked_reason") or "").strip()
        return {
            "status": status,
            "summary": summary,
            "action": action,
            "reason": reason,
        }

    def _summarize_title_focus(self, title: str) -> str:
        cleaned = re.sub(r"\s+", " ", title or "").strip()
        if not cleaned:
            return ""
        cleaned = re.sub(r"^[【\[]", "", cleaned)
        cleaned = re.sub(r"[】\]]$", "", cleaned)
        return cleaned[:48]

    def _read_chunk_text_field(self, item: dict[str, Any], key: str) -> str:
        chunk_metadata = item.get("chunk_metadata")
        if isinstance(chunk_metadata, dict):
            value = str(chunk_metadata.get(key) or "").strip()
            if value:
                return value

        metadata = item.get("metadata")
        if isinstance(metadata, dict):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value

        return ""

    def _read_chunk_milliseconds(self, item: dict[str, Any], key: str) -> int | None:
        chunk_metadata = item.get("chunk_metadata")
        if isinstance(chunk_metadata, dict):
            value = chunk_metadata.get(key)
            if value is not None:
                try:
                    milliseconds = int(value)
                except (TypeError, ValueError):
                    milliseconds = None
                if milliseconds is not None and milliseconds >= 0:
                    return milliseconds

        metadata = item.get("metadata")
        if not isinstance(metadata, dict):
            return None
        value = metadata.get(key)
        if value is None:
            return None
        try:
            milliseconds = int(value)
        except (TypeError, ValueError):
            return None
        return milliseconds if milliseconds >= 0 else None

    def _read_chunk_seek_url(self, item: dict[str, Any]) -> str | None:
        chunk_metadata = item.get("chunk_metadata")
        if isinstance(chunk_metadata, dict):
            seek_url = str(chunk_metadata.get("seek_url") or "").strip()
            if seek_url:
                return seek_url

        return build_seek_url(item.get("source_url"), self._read_chunk_milliseconds(item, "start_ms"))

    def chunk_answer(self, answer: str, chunk_size: int = 28) -> list[str]:
        text = answer or ""
        return [text[index:index + chunk_size] for index in range(0, len(text), chunk_size)] or [""]
