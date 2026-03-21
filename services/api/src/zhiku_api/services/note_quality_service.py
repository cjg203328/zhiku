from __future__ import annotations

import re
from typing import Any


class NoteQualityService:
    def evaluate(self, payload: dict[str, Any]) -> dict[str, Any]:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        transcript_segments = self._read_transcript_segments(metadata)

        capture_status = str(payload.get("status") or metadata.get("capture_status") or "").strip()
        capture_summary = str(metadata.get("capture_summary") or "").strip()
        capture_action = str(metadata.get("capture_recommended_action") or "").strip()
        title = str(payload.get("title") or "").strip()
        source_type = str(payload.get("source_type") or "").strip()
        platform = str(payload.get("platform") or "").strip()
        content_type = str(payload.get("content_type") or "").strip()
        is_video_like = platform == "bilibili" or content_type == "video"
        llm_enhanced = bool(metadata.get("llm_enhanced"))
        noisy_asr_detected = bool(metadata.get("noisy_asr_detected"))

        refined_note = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
        raw_transcript = str(metadata.get("raw_transcript_markdown") or "").strip()
        content_text = str(payload.get("content_text") or "").strip()
        summary = str(payload.get("summary") or "").strip()
        key_points = payload.get("key_points") if isinstance(payload.get("key_points"), list) else []
        key_point_count = len([item for item in key_points if str(item).strip()])
        semantic_score = self._score_semantic_clarity(
            title=title,
            summary=summary,
            key_points=key_points,
            refined_note=refined_note,
            transcript_source=str(metadata.get("transcript_source") or "").strip(),
            llm_enhanced=llm_enhanced,
            noisy_asr_detected=noisy_asr_detected,
        )

        segment_count = len(transcript_segments)
        seek_ready_count = len([item for item in transcript_segments if item["seek_url"]])
        timestamps_available = bool(metadata.get("timestamps_available")) or any(item["start_ms"] is not None for item in transcript_segments)
        timestamps_estimated = bool(metadata.get("timestamps_estimated"))

        capture_score = self._score_capture(
            capture_status=capture_status,
            is_video_like=is_video_like,
            timestamps_available=timestamps_available,
            timestamps_estimated=timestamps_estimated,
            content_text=content_text,
        )
        refined_score = self._score_refined_note(
            refined_note=refined_note,
            summary=summary,
            key_point_count=key_point_count,
            semantic_score=semantic_score,
            llm_enhanced=llm_enhanced,
        )
        raw_evidence_score = self._score_raw_evidence(
            segment_count=segment_count,
            raw_transcript=raw_transcript,
            content_text=content_text,
            timestamps_available=timestamps_available,
        )
        retrieval_score = self._score_retrieval(
            segment_count=segment_count,
            content_text=content_text,
            summary=summary,
            key_point_count=key_point_count,
        )
        time_jump_score = self._score_time_jump(
            is_video_like=is_video_like,
            timestamps_available=timestamps_available,
            timestamps_estimated=timestamps_estimated,
            seek_ready_count=seek_ready_count,
            segment_count=segment_count,
        )

        double_note_ready = refined_score >= 72 and raw_evidence_score >= 70
        time_jump_ready = is_video_like and time_jump_score >= 80
        retrieval_ready = retrieval_score >= 72 and raw_evidence_score >= 58
        question_answer_ready = (
            retrieval_ready
            and capture_score >= 60
            and semantic_score >= 58
            and not self._is_capture_blocked(capture_status)
            and (not noisy_asr_detected or llm_enhanced)
        )
        agent_ready = llm_enhanced or (semantic_score >= 68 and not noisy_asr_detected)

        dimensions = {
            "capture": {
                "score": capture_score,
                "label": self._describe_dimension("capture", capture_score, ready=capture_score >= 70),
                "ready": capture_score >= 70,
                "applicable": True,
            },
            "refined_note": {
                "score": refined_score,
                "label": self._describe_dimension("refined_note", refined_score, ready=refined_score >= 72),
                "ready": refined_score >= 72,
                "applicable": True,
            },
            "raw_evidence": {
                "score": raw_evidence_score,
                "label": self._describe_dimension("raw_evidence", raw_evidence_score, ready=raw_evidence_score >= 70),
                "ready": raw_evidence_score >= 70,
                "applicable": True,
            },
            "retrieval": {
                "score": retrieval_score,
                "label": self._describe_dimension("retrieval", retrieval_score, ready=retrieval_ready),
                "ready": retrieval_ready,
                "applicable": True,
            },
            "time_jump": {
                "score": time_jump_score,
                "label": self._describe_dimension("time_jump", time_jump_score, ready=time_jump_ready, applicable=is_video_like),
                "ready": time_jump_ready,
                "applicable": is_video_like,
            },
            "understanding": {
                "score": semantic_score,
                "label": self._describe_dimension("understanding", semantic_score, ready=agent_ready),
                "ready": agent_ready,
                "applicable": True,
            },
        }

        weights = {
            "capture": 0.24,
            "refined_note": 0.18,
            "raw_evidence": 0.20,
            "retrieval": 0.16,
            "time_jump": 0.10,
            "understanding": 0.12,
        }
        applicable_weight = sum(weights[name] for name, item in dimensions.items() if item["applicable"])
        overall_score = 0
        if applicable_weight > 0:
            overall_score = round(
                sum(dimensions[name]["score"] * weights[name] for name in dimensions if dimensions[name]["applicable"])
                / applicable_weight
            )

        level, label = self._resolve_level(
            overall_score=overall_score,
            capture_status=capture_status,
            double_note_ready=double_note_ready,
            retrieval_ready=retrieval_ready,
            time_jump_ready=time_jump_ready,
            is_video_like=is_video_like,
            semantic_score=semantic_score,
            noisy_asr_detected=noisy_asr_detected,
            llm_enhanced=llm_enhanced,
        )

        quality_summary = self._build_summary(
            level=level,
            capture_status=capture_status,
            capture_summary=capture_summary,
            is_video_like=is_video_like,
            double_note_ready=double_note_ready,
            time_jump_ready=time_jump_ready,
            retrieval_ready=retrieval_ready,
            timestamps_estimated=timestamps_estimated,
            semantic_score=semantic_score,
            llm_enhanced=llm_enhanced,
            noisy_asr_detected=noisy_asr_detected,
        )
        recommended_action = self._build_recommended_action(
            level=level,
            capture_status=capture_status,
            capture_action=capture_action,
            double_note_ready=double_note_ready,
            retrieval_ready=retrieval_ready,
            time_jump_ready=time_jump_ready,
            is_video_like=is_video_like,
            semantic_score=semantic_score,
            llm_enhanced=llm_enhanced,
            noisy_asr_detected=noisy_asr_detected,
        )

        return {
            "score": overall_score,
            "level": level,
            "label": label,
            "summary": quality_summary,
            "recommended_action": recommended_action,
            "double_note_ready": double_note_ready,
            "time_jump_ready": time_jump_ready,
            "retrieval_ready": retrieval_ready,
            "question_answer_ready": question_answer_ready,
            "refined_note_ready": refined_score >= 72,
            "raw_evidence_ready": raw_evidence_score >= 70,
            "transcript_segments": segment_count,
            "seek_ready_segments": seek_ready_count,
            "timestamps_estimated": timestamps_estimated,
            "semantic_score": semantic_score,
            "agent_ready": agent_ready,
            "llm_enhanced": llm_enhanced,
            "sort_score": overall_score,
            "dimensions": dimensions,
            "source_type": source_type,
            "platform": platform,
            "content_type": content_type,
            "capture_status": capture_status,
        }

    def _read_transcript_segments(self, metadata: dict[str, Any]) -> list[dict[str, Any]]:
        raw_segments = metadata.get("transcript_segments")
        if not isinstance(raw_segments, list):
            return []

        segments: list[dict[str, Any]] = []
        for item in raw_segments:
            if not isinstance(item, dict):
                continue
            segments.append(
                {
                    "start_ms": self._coerce_milliseconds(item.get("start_ms")),
                    "end_ms": self._coerce_milliseconds(item.get("end_ms")),
                    "seek_url": str(item.get("seek_url") or "").strip() or None,
                }
            )
        return segments

    def _score_capture(
        self,
        *,
        capture_status: str,
        is_video_like: bool,
        timestamps_available: bool,
        timestamps_estimated: bool,
        content_text: str,
    ) -> int:
        status_scores = {
            "ready": 96 if timestamps_available and not timestamps_estimated else 88,
            "ready_estimated": 80,
            "needs_cookie": 34,
            "needs_asr": 38,
            "asr_failed": 24,
            "limited": 28,
            "preview_ready": 18,
        }
        if capture_status in status_scores:
            return status_scores[capture_status]

        if not is_video_like:
            if len(content_text) >= 600:
                return 88
            if len(content_text) >= 180:
                return 72
            return 40

        if timestamps_available:
            return 84 if timestamps_estimated else 92
        if content_text:
            return 54
        return 24

    def _score_refined_note(
        self,
        *,
        refined_note: str,
        summary: str,
        key_point_count: int,
        semantic_score: int,
        llm_enhanced: bool,
    ) -> int:
        note_length = len(refined_note)
        if note_length >= 600 and key_point_count >= 4:
            base_score = 95
        elif note_length >= 320:
            base_score = 86
        elif note_length >= 140:
            base_score = 74
        elif len(summary) >= 80 and key_point_count >= 2:
            base_score = 64
        elif len(summary) >= 40:
            base_score = 52
        else:
            base_score = 20

        if llm_enhanced:
            return max(base_score, min(96, semantic_score + 4))

        if base_score >= 74:
            return round(base_score * 0.55 + semantic_score * 0.45)
        return round(base_score * 0.70 + semantic_score * 0.30)

    def _score_raw_evidence(
        self,
        *,
        segment_count: int,
        raw_transcript: str,
        content_text: str,
        timestamps_available: bool,
    ) -> int:
        if segment_count >= 8:
            return 96 if timestamps_available else 88
        if segment_count >= 4:
            return 90 if timestamps_available else 78
        if segment_count >= 1:
            return 82 if timestamps_available else 70
        if len(raw_transcript) >= 600:
            return 76
        if len(content_text) >= 1000:
            return 80
        if len(content_text) >= 280:
            return 62
        return 24

    def _score_retrieval(
        self,
        *,
        segment_count: int,
        content_text: str,
        summary: str,
        key_point_count: int,
    ) -> int:
        if segment_count >= 6 or len(content_text) >= 1200:
            return 92
        if segment_count >= 3 or len(content_text) >= 500:
            return 84
        if len(content_text) >= 240 or key_point_count >= 3:
            return 72
        if len(summary) >= 60:
            return 56
        return 22

    def _score_time_jump(
        self,
        *,
        is_video_like: bool,
        timestamps_available: bool,
        timestamps_estimated: bool,
        seek_ready_count: int,
        segment_count: int,
    ) -> int:
        if not is_video_like:
            return 0
        if timestamps_available and seek_ready_count >= max(1, min(segment_count, 2)):
            return 96 if not timestamps_estimated else 72
        if timestamps_available:
            return 78 if not timestamps_estimated else 64
        if segment_count > 0:
            return 24
        return 0

    def _resolve_level(
        self,
        *,
        overall_score: int,
        capture_status: str,
        double_note_ready: bool,
        retrieval_ready: bool,
        time_jump_ready: bool,
        is_video_like: bool,
        semantic_score: int,
        noisy_asr_detected: bool,
        llm_enhanced: bool,
    ) -> tuple[str, str]:
        if self._is_capture_blocked(capture_status):
            return "blocked", "待补全"
        if (
            overall_score >= 88
            and semantic_score >= 72
            and double_note_ready
            and retrieval_ready
            and (not is_video_like or time_jump_ready)
            and (not noisy_asr_detected or llm_enhanced)
        ):
            return "high", "高质量笔记"
        if overall_score >= 74 and retrieval_ready and semantic_score >= 60 and (not noisy_asr_detected or llm_enhanced):
            return "good", "可直接问答"
        if overall_score >= 56:
            return "usable", "可继续整理"
        return "limited", "基础建档"

    def _build_summary(
        self,
        *,
        level: str,
        capture_status: str,
        capture_summary: str,
        is_video_like: bool,
        double_note_ready: bool,
        time_jump_ready: bool,
        retrieval_ready: bool,
        timestamps_estimated: bool,
        semantic_score: int,
        llm_enhanced: bool,
        noisy_asr_detected: bool,
    ) -> str:
        if level == "blocked":
            return capture_summary or "这条内容还没有形成完整的正文证据层，继续做精准问答的风险较高。"
        if level == "high":
            if is_video_like and timestamps_estimated:
                return "双层笔记已成型，问答和检索已可用；时间回看来自估算转写，关键片段建议再核对一次。"
            return "这条内容已经具备精炼笔记、原始证据、检索能力和稳定回看能力，可直接作为问答数据源。"
        if noisy_asr_detected and not llm_enhanced:
            return "当前证据层、检索和时间回看已可用，但原始转写噪声仍明显，更适合先围绕片段问答与核对，不建议直接把现有精炼层当最终结论。"
        if retrieval_ready and semantic_score < 60 and not llm_enhanced:
            return "证据层和检索已可用，但当前自动整理的语义质量偏低，更适合作为回看与核对底座，不适合直接把现有笔记当最终结论。"
        if level == "good":
            if is_video_like and not time_jump_ready:
                return "双层笔记和问答准备度已经不错，但时间回看还不够稳定，适合先用于检索和追问。"
            return "这条内容已经具备较稳定的问答条件，适合继续验证检索、引用和追问效果。"
        if level == "usable":
            if double_note_ready:
                return "双层笔记已具雏形，但证据密度或检索准备度还不够强，适合继续补充整理。"
            return "当前已完成基础整理，但还更适合作为草稿档案，暂不建议直接当作高质量问答数据源。"
        if capture_status == "preview_ready":
            return "当前还是预览级结果，适合先建档，不适合直接当作完整知识笔记。"
        return "当前只完成了基础建档，还没有形成足够稳定的精炼层和证据层。"

    def _build_recommended_action(
        self,
        *,
        level: str,
        capture_status: str,
        capture_action: str,
        double_note_ready: bool,
        retrieval_ready: bool,
        time_jump_ready: bool,
        is_video_like: bool,
        semantic_score: int,
        llm_enhanced: bool,
        noisy_asr_detected: bool,
    ) -> str:
        if level == "blocked":
            return capture_action or "先补齐登录态或音频转写能力，再重新解析这条内容。"
        if noisy_asr_detected and not llm_enhanced:
            return "优先接入理解模型重整精炼层，同时保留时间片段用于核对；在此之前，更适合围绕具体片段继续提问。"
        if retrieval_ready and semantic_score < 60 and not llm_enhanced:
            return "接入理解模型重整精炼层，同时保留向量检索和时间戳引用，用“先理解、再核对”的方式回答会更稳。"
        if not double_note_ready:
            return "优先补齐精炼笔记和原始正文，让这条内容具备双层笔记结构。"
        if is_video_like and not time_jump_ready:
            return "优先补齐带时间戳的转写片段，提升回看和引用定位的稳定性。"
        if not retrieval_ready:
            return "继续补充正文密度或片段切分，再拿它做问答验证会更稳。"
        if capture_status == "ready_estimated":
            return "可以直接问答验证，但关键结论建议回到原视频片段再核对一次。"
        return "可以直接把这条笔记作为问答和检索数据源继续使用。"

    def _describe_dimension(self, name: str, score: int, *, ready: bool, applicable: bool = True) -> str:
        if not applicable:
            return "不适用"
        if score >= 88:
            state = "强"
        elif score >= 72:
            state = "可用"
        elif score >= 56:
            state = "一般"
        else:
            state = "偏弱"

        name_map = {
            "capture": "采集层",
            "refined_note": "精炼层",
            "raw_evidence": "证据层",
            "retrieval": "检索层",
            "time_jump": "回看层",
            "understanding": "理解层",
        }
        suffix = "已就绪" if ready else "待加强"
        return f"{name_map.get(name, name)}{state}，{suffix}"

    def _is_capture_blocked(self, capture_status: str) -> bool:
        return capture_status in {"needs_cookie", "needs_asr", "asr_failed", "limited", "preview_ready"}

    def _coerce_milliseconds(self, value: Any) -> int | None:
        if value is None:
            return None
        try:
            milliseconds = int(value)
        except (TypeError, ValueError):
            return None
        return milliseconds if milliseconds >= 0 else None

    def _score_semantic_clarity(
        self,
        *,
        title: str,
        summary: str,
        key_points: list[Any],
        refined_note: str,
        transcript_source: str,
        llm_enhanced: bool,
        noisy_asr_detected: bool,
    ) -> int:
        if llm_enhanced and (summary or refined_note):
            return 92

        snippets: list[str] = []
        if summary.strip():
            snippets.append(summary.strip())
        snippets.extend([str(item).strip() for item in key_points if str(item).strip()])

        if not snippets and refined_note.strip():
            for raw_line in refined_note.splitlines():
                line = re.sub(r"^#+\s*", "", raw_line).strip()
                line = re.sub(r"^[-*]\s+", "", line).strip()
                if line:
                    snippets.append(line)
                if len(snippets) >= 4:
                    break

        if not snippets:
            return 24

        compact_snippets = snippets[:4]
        joined = " ".join(compact_snippets)
        normalized_snippets = [re.sub(r"\s+", "", item) for item in compact_snippets]
        avg_length = sum(len(item) for item in compact_snippets) / max(len(compact_snippets), 1)
        punctuation_count = len(re.findall(r"[，。；：、“”！？,.!?;:]", joined))
        punctuation_density = punctuation_count / max(len(joined), 1)
        filler_tokens = ("对不对", "然后", "就是", "这个", "那个", "一下", "是不是", "有点", "现在", "我们", "这里")
        filler_hits = sum(joined.count(token) for token in filler_tokens)

        score = 86
        if avg_length > 52:
            score -= 18
        elif avg_length > 40:
            score -= 8

        if punctuation_density < 0.015:
            score -= 10
        if punctuation_density < 0.008:
            score -= 8

        repeated_prefixes = 0
        for index, item in enumerate(normalized_snippets):
            prefix = item[:18]
            if prefix and any(prefix == other[:18] for other in normalized_snippets[:index]):
                repeated_prefixes += 1
        score -= repeated_prefixes * 10

        if len({item[:16] for item in normalized_snippets if item}) <= 1 and len(normalized_snippets) >= 3:
            score -= 14

        if filler_hits >= 8:
            score -= min(18, filler_hits)

        title_terms = self._extract_title_terms(title)
        if title_terms and not any(term in joined for term in title_terms):
            score -= 10

        if transcript_source == "asr":
            score -= 6
            if filler_hits >= 8 and avg_length > 44:
                score -= 10
        if noisy_asr_detected:
            score -= 12

        return max(18, min(96, round(score)))

    def _extract_title_terms(self, title: str) -> list[str]:
        stop_terms = {"视频", "内容", "教程", "分享", "详解", "解析", "笔记"}
        terms: list[str] = []
        for item in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}", title or ""):
            cleaned = item.strip()
            if not cleaned or cleaned in stop_terms or cleaned in terms:
                continue
            terms.append(cleaned)
        return terms[:4]
