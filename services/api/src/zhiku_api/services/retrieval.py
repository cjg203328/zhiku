"""RetrievalMixin — chunk/content 检索、评分融合、质量评估。

从 chat_service.py 拆分，由 ChatService 通过 mixin 继承。
"""
from __future__ import annotations

from typing import Any


class RetrievalMixin:
    """检索逻辑：多路召回 + RRF 融合 + 质量评分。"""

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
                repository, query_variants,
                prioritized_content_ids=prioritized_content_ids, limit=limit,
            )
        collected: dict[str, dict[str, Any]] = {}
        for vi, variant in enumerate(query_variants):
            for rank, row in enumerate(repository.search_content_chunks(variant, limit=limit)):
                key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted, base_score=float(row.get("score", 0)) + self._route_boost("chunk", vi, rank)
                )
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        if len(collected) < max(3, limit // 2):
            for vi, variant in enumerate(query_variants):
                for rank, row in enumerate(repository.search_content_chunks(variant, limit=limit)):
                    key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                    boosted = dict(row)
                    boosted["score"] = self._apply_quality_boost(
                        boosted, base_score=float(row.get("score", 0)) + self._route_boost("chunk", vi, rank)
                    )
                    boosted["retrieval_path"] = boosted.get("retrieval_path") or "global_chunk"
                    if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                        collected[key] = boosted
        return sorted(collected.values(), key=lambda x: float(x.get("score", 0)), reverse=True)[:limit]

    def _collect_scoped_chunk_matches(
        self, repository: Any, query_variants: list[str], *, content_id: str, limit: int,
    ) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for vi, variant in enumerate(query_variants):
            for rank, row in enumerate(repository.search_content_chunks(variant, limit=limit, content_id=content_id, chunk_id=None)):
                key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted, base_score=float(row.get("score", 0)) + self._route_boost("chunk", vi, rank)
                )
                boosted["retrieval_path"] = "scoped_chunk"
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        return sorted(collected.values(), key=lambda x: float(x.get("score", 0)), reverse=True)[:limit]

    def _collect_content_matches(
        self, repository: Any, query_variants: list[str], *, limit: int,
    ) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        for vi, variant in enumerate(query_variants):
            for rank, row in enumerate(repository.search_contents(variant, limit=limit)):
                key = str(row.get("id"))
                boosted = dict(row)
                boosted["score"] = self._apply_quality_boost(
                    boosted, base_score=float(row.get("score", 0)) + self._route_boost("content", vi, rank)
                )
                boosted["route_type"] = "content"
                if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                    collected[key] = boosted
        return sorted(collected.values(), key=lambda x: float(x.get("score", 0)), reverse=True)[:limit]

    def _collect_hierarchical_chunk_matches(
        self, repository: Any, query_variants: list[str], *, prioritized_content_ids: list[str], limit: int,
    ) -> list[dict[str, Any]]:
        collected: dict[str, dict[str, Any]] = {}
        target_rank_map = {cid: i for i, cid in enumerate(prioritized_content_ids)}
        for cid in prioritized_content_ids:
            cr = target_rank_map.get(cid, 0)
            per = max(4, limit // max(len(prioritized_content_ids), 1))
            for vi, variant in enumerate(query_variants):
                for rank, row in enumerate(repository.search_content_chunks(variant, limit=per, content_id=cid)):
                    key = row.get("chunk_id") or f"{row.get('content_id')}::{row.get('chunk_index', 0)}"
                    boosted = dict(row)
                    boosted["score"] = self._apply_quality_boost(
                        boosted, base_score=(
                            float(row.get("score", 0))
                            + self._route_boost("chunk", vi, rank)
                            + max(0.0, 1.2 - cr * 0.22)
                        )
                    )
                    boosted["retrieval_path"] = "content_to_chunk"
                    if key not in collected or float(boosted["score"]) > float(collected[key].get("score", 0)):
                        collected[key] = boosted
        return sorted(collected.values(), key=lambda x: float(x.get("score", 0)), reverse=True)[:limit]

    @staticmethod
    def _minmax_normalize(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not items:
            return items
        scores = [float(item.get("score", 0)) for item in items]
        lo, hi = min(scores), max(scores)
        span = hi - lo
        result = []
        for item, score in zip(items, scores):
            n = dict(item)
            n["score"] = (score - lo) / span if span > 0 else 1.0
            result.append(n)
        return result

    def _fuse_matches(
        self, chunk_matches: list[dict[str, Any]], content_matches: list[dict[str, Any]], *, limit: int,
    ) -> list[dict[str, Any]]:
        seen_chunk_ids: set[str] = set()
        seen_content_ids: set[str] = set()
        candidates: list[dict[str, Any]] = []
        for item in self._minmax_normalize(chunk_matches):
            key = str(
                item.get("chunk_id")
                or f"{item.get('content_id')}::{item.get('route_type') or 'chunk'}::{item.get('heading') or item.get('chunk_index', 0)}"
            )
            if key and key not in seen_chunk_ids:
                n = dict(item)
                n["route_type"] = n.get("route_type") or "chunk"
                n["title"] = n.get("title") or "未命名内容"
                n["snippet"] = n.get("snippet") or n.get("chunk_summary") or ""
                candidates.append(n)
                seen_chunk_ids.add(key)
                if n.get("content_id"):
                    seen_content_ids.add(str(n["content_id"]))
        for item in self._minmax_normalize(content_matches):
            ckey = str(item.get("id") or "")
            if not ckey or ckey in seen_content_ids:
                continue
            candidates.append({
                "content_id": ckey, "chunk_id": None, "chunk_index": None, "heading": None,
                "title": item.get("title") or "未命名内容",
                "platform": item.get("platform"), "source_type": item.get("source_type"),
                "source_url": item.get("source_url"), "summary": item.get("summary"),
                "chunk_summary": item.get("summary"),
                "snippet": item.get("snippet") or item.get("summary") or "",
                "score": float(item.get("score", 0)), "route_type": "content",
                "status": item.get("status"),
                "metadata": item.get("metadata") if isinstance(item.get("metadata"), dict) else {},
            })
            seen_content_ids.add(ckey)
        candidates.sort(key=lambda r: float(r.get("score", 0)), reverse=True)
        return candidates[:limit]

    def _route_boost(self, route_type: str, variant_index: int, rank: int) -> float:
        route_base = 1.8 if route_type == "chunk" else 0.9
        return route_base + max(0.0, 1.0 - variant_index * 0.18) + max(0.0, 0.8 - rank * 0.08)

    def _apply_quality_boost(self, item: dict[str, Any], *, base_score: float) -> float:
        metadata = item.get("metadata")
        md = metadata if isinstance(metadata, dict) else {}
        nq = md.get("note_quality")
        nq = nq if isinstance(nq, dict) else {}
        score = base_score
        boost = 0.0
        try:
            qs = float(nq.get("sort_score", nq.get("score", 0)) or 0)
        except (TypeError, ValueError):
            qs = 0.0
        if qs > 0:
            boost += min(1.4, max(0.0, qs / 100.0) * 1.4)
        if nq.get("question_answer_ready") is True:
            boost += 0.9
        elif nq.get("retrieval_ready") is True:
            boost += 0.45
        if nq.get("time_jump_ready") is True:
            boost += 0.22
        status = str(item.get("status") or nq.get("capture_status") or md.get("capture_status") or "").strip()
        boost += {"ready": 0.62, "ready_estimated": 0.28, "limited": -0.25,
                  "needs_cookie": -0.85, "needs_asr": -0.75, "asr_failed": -1.0, "preview_ready": -1.15}.get(status, 0.0)
        item["base_score"] = round(base_score, 2)
        item["quality_boost"] = round(boost, 2)
        return round(score + boost, 4)
