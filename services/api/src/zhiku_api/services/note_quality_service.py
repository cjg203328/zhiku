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
        transcript_source = str(metadata.get("transcript_source") or "").strip()
        note_style = str(metadata.get("note_style") or "").strip()
        note_output_quality = metadata.get("note_output_quality") if isinstance(metadata.get("note_output_quality"), dict) else {}

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
            transcript_source=transcript_source,
            llm_enhanced=llm_enhanced,
            noisy_asr_detected=noisy_asr_detected,
        )

        segment_count = len(transcript_segments)
        seek_ready_count = len([item for item in transcript_segments if item["seek_url"]])
        timestamps_available = bool(metadata.get("timestamps_available")) or any(item["start_ms"] is not None for item in transcript_segments)
        timestamps_estimated = bool(metadata.get("timestamps_estimated"))
        semantic_units = self._read_semantic_units(metadata, content_text)
        capture_gap_report = self._build_capture_gap_report(
            capture_status=capture_status,
            transcript_source=transcript_source,
            is_video_like=is_video_like,
            timestamps_available=timestamps_available,
            timestamps_estimated=timestamps_estimated,
            segment_count=segment_count,
            seek_ready_count=seek_ready_count,
            noisy_asr_detected=noisy_asr_detected,
            content_text=content_text,
        )
        note_coverage_report = self._build_note_coverage_report(
            semantic_units=semantic_units,
            refined_note=refined_note,
            summary=summary,
            key_points=key_points,
        )

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
        accuracy_score = self._score_source_reliability(
            capture_status=capture_status,
            transcript_source=transcript_source,
            llm_enhanced=llm_enhanced,
            noisy_asr_detected=noisy_asr_detected,
            timestamps_available=timestamps_available,
            content_text=content_text,
        )
        coverage_score = self._score_content_coverage(
            is_video_like=is_video_like,
            capture_status=capture_status,
            content_text=content_text,
            summary=summary,
            key_point_count=key_point_count,
            segment_count=segment_count,
            timestamps_available=timestamps_available,
            note_coverage_report=note_coverage_report,
            capture_gap_report=capture_gap_report,
        )
        note_structure_score = self._score_note_structure(
            refined_note=refined_note,
            summary=summary,
            key_points=key_points,
            note_style=note_style,
            llm_enhanced=llm_enhanced,
            note_output_quality=note_output_quality,
            note_coverage_report=note_coverage_report,
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
        high_confidence_answer_ready = (
            question_answer_ready
            and accuracy_score >= 72
            and coverage_score >= 72
            and note_structure_score >= 68
            and float(note_coverage_report.get("coverage_ratio") or 0.0) >= 0.55
        )

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
            "accuracy": {
                "score": accuracy_score,
                "label": self._describe_dimension("accuracy", accuracy_score, ready=accuracy_score >= 72),
                "ready": accuracy_score >= 72,
                "applicable": True,
            },
            "coverage": {
                "score": coverage_score,
                "label": self._describe_dimension("coverage", coverage_score, ready=coverage_score >= 72),
                "ready": coverage_score >= 72,
                "applicable": True,
            },
            "note_structure": {
                "score": note_structure_score,
                "label": self._describe_dimension("note_structure", note_structure_score, ready=note_structure_score >= 72),
                "ready": note_structure_score >= 72,
                "applicable": True,
            },
        }

        weights = {
            "capture": 0.20,
            "refined_note": 0.16,
            "raw_evidence": 0.18,
            "retrieval": 0.14,
            "time_jump": 0.09,
            "understanding": 0.11,
            "accuracy": 0.05,
            "coverage": 0.04,
            "note_structure": 0.03,
        }
        applicable_weight = sum(weights.get(name, 0.0) for name, item in dimensions.items() if item["applicable"])
        overall_score = 0
        if applicable_weight > 0:
            overall_score = round(
                sum(dimensions[name]["score"] * weights.get(name, 0.0) for name in dimensions if dimensions[name]["applicable"])
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
            accuracy_score=accuracy_score,
            coverage_score=coverage_score,
            note_structure_score=note_structure_score,
            capture_gap_report=capture_gap_report,
            note_coverage_report=note_coverage_report,
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
            accuracy_score=accuracy_score,
            coverage_score=coverage_score,
            note_structure_score=note_structure_score,
            capture_gap_report=capture_gap_report,
            note_coverage_report=note_coverage_report,
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
            "high_confidence_answer_ready": high_confidence_answer_ready,
            "refined_note_ready": refined_score >= 72,
            "raw_evidence_ready": raw_evidence_score >= 70,
            "transcript_segments": segment_count,
            "seek_ready_segments": seek_ready_count,
            "timestamps_estimated": timestamps_estimated,
            "semantic_score": semantic_score,
            "agent_ready": agent_ready,
            "llm_enhanced": llm_enhanced,
            "source_reliability_score": accuracy_score,
            "coverage_score": coverage_score,
            "note_structure_score": note_structure_score,
            "capture_gap_report": capture_gap_report,
            "note_coverage_report": note_coverage_report,
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

    def _read_semantic_units(self, metadata: dict[str, Any], content_text: str) -> list[dict[str, Any]]:
        for key in ("semantic_transcript_segments", "transcript_segments"):
            raw_segments = metadata.get(key)
            if not isinstance(raw_segments, list):
                continue

            raw_texts = [
                item for item in raw_segments
                if isinstance(item, dict) and str(item.get("text") or "").strip()
            ]
            total = len(raw_texts)
            if total <= 0:
                continue

            units: list[dict[str, Any]] = []
            for index, item in enumerate(raw_texts):
                text = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
                if not text:
                    continue
                start_ms = self._coerce_milliseconds(item.get("start_ms"))
                units.append(
                    {
                        "index": index,
                        "label": self._describe_semantic_unit_label(index, start_ms, total),
                        "position": self._describe_unit_position(index, total),
                        "text": text,
                    }
                )
            if units:
                return units[:10]

        fallback_units = self._split_text_units(content_text, max_units=6, target_chars=140)
        total = len(fallback_units)
        return [
            {
                "index": index,
                "label": self._describe_semantic_unit_label(index, None, total),
                "position": self._describe_unit_position(index, total),
                "text": text,
            }
            for index, text in enumerate(fallback_units)
        ]

    def _describe_semantic_unit_label(self, index: int, start_ms: int | None, total: int) -> str:
        position = self._describe_unit_position(index, total)
        if start_ms is not None:
            return f"{position} · {self._format_timestamp_label(start_ms)}"
        return position

    def _describe_unit_position(self, index: int, total: int) -> str:
        if total <= 1:
            return "核心内容"
        if index == 0:
            return "开头背景"
        if index == total - 1:
            return "收尾结论"
        if total <= 3:
            return "中段展开"
        pivot = total / 2
        if index < pivot:
            return "前段展开"
        return "中后段展开"

    def _format_timestamp_label(self, milliseconds: int) -> str:
        total_seconds = max(0, int(milliseconds / 1000))
        minutes, seconds = divmod(total_seconds, 60)
        hours, minutes = divmod(minutes, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _split_text_units(self, text: str, *, max_units: int, target_chars: int) -> list[str]:
        compact = re.sub(r"\s+", " ", str(text or "")).strip()
        if not compact:
            return []

        sentence_parts = [
            item.strip()
            for item in re.split(r"(?<=[。！？；.!?])\s+|(?<=[。！？；.!?])", compact)
            if item and item.strip()
        ]
        if not sentence_parts:
            sentence_parts = [compact]

        chunks: list[str] = []
        buffer = ""
        for part in sentence_parts:
            candidate = f"{buffer}{part}".strip()
            if buffer and len(candidate) > target_chars:
                chunks.append(buffer.strip())
                buffer = part
                if len(chunks) >= max_units:
                    break
                continue
            buffer = candidate

        if buffer and len(chunks) < max_units:
            chunks.append(buffer.strip())
        return chunks[:max_units]

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

    def _score_source_reliability(
        self,
        *,
        capture_status: str,
        transcript_source: str,
        llm_enhanced: bool,
        noisy_asr_detected: bool,
        timestamps_available: bool,
        content_text: str,
    ) -> int:
        if capture_status in {"preview_ready", "limited"}:
            return 28
        if capture_status in {"needs_cookie", "needs_asr", "asr_failed"}:
            return 24

        if transcript_source == "subtitle":
            score = 94 if timestamps_available else 88
        elif transcript_source.startswith("asr"):
            score = 74
        elif transcript_source == "description":
            score = 48
        elif len(content_text) >= 800:
            score = 82
        elif len(content_text) >= 240:
            score = 66
        else:
            score = 38

        if noisy_asr_detected:
            score -= 16
        if transcript_source.startswith("asr") and llm_enhanced:
            score += 6
        return max(18, min(96, round(score)))

    def _score_content_coverage(
        self,
        *,
        is_video_like: bool,
        capture_status: str,
        content_text: str,
        summary: str,
        key_point_count: int,
        segment_count: int,
        timestamps_available: bool,
        note_coverage_report: dict[str, Any],
        capture_gap_report: dict[str, Any],
    ) -> int:
        if capture_status in {"preview_ready", "limited"}:
            return 22
        score = 28
        if is_video_like:
            if segment_count >= 10 and len(content_text) >= 1200 and timestamps_available:
                score = 94
            elif segment_count >= 6 and len(content_text) >= 800:
                score = 84
            elif segment_count >= 3 and len(content_text) >= 360:
                score = 72
            elif len(summary) >= 80 and key_point_count >= 3:
                score = 56
        else:
            if len(content_text) >= 2200 and key_point_count >= 4:
                score = 94
            elif len(content_text) >= 1200 and key_point_count >= 3:
                score = 84
            elif len(content_text) >= 480 and (key_point_count >= 2 or len(summary) >= 80):
                score = 72
            elif len(summary) >= 60:
                score = 54
            else:
                score = 26

        coverage_ratio = float(note_coverage_report.get("coverage_ratio") or 0.0)
        total_units = int(note_coverage_report.get("total_units") or 0)
        if total_units >= 3:
            if coverage_ratio >= 0.78:
                score += 8
            elif coverage_ratio >= 0.58:
                score += 3
            elif coverage_ratio < 0.35:
                score -= 14
            elif coverage_ratio < 0.5:
                score -= 8

        gap_count = int(capture_gap_report.get("gap_count") or 0)
        if gap_count >= 3:
            score -= min(14, (gap_count - 1) * 4)
        elif gap_count == 2:
            score -= 4
        return max(18, min(96, round(score)))

    def _score_note_structure(
        self,
        *,
        refined_note: str,
        summary: str,
        key_points: list[Any],
        note_style: str,
        llm_enhanced: bool,
        note_output_quality: dict[str, Any],
        note_coverage_report: dict[str, Any],
    ) -> int:
        note = refined_note.strip()
        if not note:
            if len(summary) >= 60 and len([item for item in key_points if str(item).strip()]) >= 3:
                return 54
            return 22

        score = 72
        required_sections = ("## 核心结论", "## 精炼正文", "## 重点摘录")
        if note_style == "qa":
            required_sections = ("## 问题结论", "## 回答整理", "## 关键答案")
        elif note_style == "brief":
            required_sections = ("## 快速摘要", "## 精炼正文", "## 重点摘录")

        present_sections = sum(1 for title in required_sections if title in note)
        if present_sections == len(required_sections):
            score += 12
        elif present_sections >= 2:
            score += 4
        else:
            score -= 18

        paragraphs = [
            line.strip()
            for line in note.splitlines()
            if line.strip() and not line.lstrip().startswith("#") and not re.match(r"^[-*]\s+", line.strip())
        ]
        if len(paragraphs) >= 3:
            score += 4
        elif len(paragraphs) <= 1:
            score -= 10

        max_paragraph_length = max((len(item) for item in paragraphs), default=0)
        if max_paragraph_length > 200:
            score -= 14
        elif max_paragraph_length > 140:
            score -= 8

        punctuation_density = (len(re.findall(r"[，。；：、“”！？,.!?;:]", note)) / max(len(note), 1))
        if punctuation_density < 0.014:
            score -= 12
        if punctuation_density < 0.008:
            score -= 10

        normalized_paragraphs = [re.sub(r"\s+", "", item.lower()) for item in paragraphs if item]
        duplicate_hits = 0
        seen: set[str] = set()
        for item in normalized_paragraphs:
            signature = item[:48]
            if signature in seen:
                duplicate_hits += 1
                continue
            seen.add(signature)
        score -= duplicate_hits * 10

        bullet_count = len(re.findall(r"(?m)^[-*]\s+", note))
        if bullet_count >= 3:
            score += 4
        elif bullet_count == 0:
            score -= 4

        if llm_enhanced and present_sections >= 2:
            score += 2

        section_count = int(note_output_quality.get("section_count") or 0)
        paragraph_count = int(note_output_quality.get("paragraph_count") or 0)
        duplicate_hits_meta = int(note_output_quality.get("duplicate_hits") or 0)
        max_paragraph_length_meta = int(note_output_quality.get("max_paragraph_length") or 0)
        if section_count >= 3:
            score += 2
        if paragraph_count <= 2 and note:
            score -= 4
        if duplicate_hits_meta > duplicate_hits:
            score -= min(10, (duplicate_hits_meta - duplicate_hits) * 4)
        if max_paragraph_length_meta > max_paragraph_length and max_paragraph_length_meta > 180:
            score -= 4

        coverage_ratio = float(note_coverage_report.get("coverage_ratio") or 0.0)
        total_units = int(note_coverage_report.get("total_units") or 0)
        if total_units >= 3 and coverage_ratio < 0.4:
            score -= 8
        elif total_units >= 3 and coverage_ratio < 0.55:
            score -= 4
        return max(18, min(96, round(score)))

    def _build_capture_gap_report(
        self,
        *,
        capture_status: str,
        transcript_source: str,
        is_video_like: bool,
        timestamps_available: bool,
        timestamps_estimated: bool,
        segment_count: int,
        seek_ready_count: int,
        noisy_asr_detected: bool,
        content_text: str,
    ) -> dict[str, Any]:
        items: list[dict[str, str]] = []
        seen_codes: set[str] = set()

        def add_item(code: str, label: str, severity: str, detail: str) -> None:
            if code in seen_codes:
                return
            seen_codes.add(code)
            items.append(
                {
                    "code": code,
                    "label": label,
                    "severity": severity,
                    "detail": detail,
                }
            )

        if capture_status == "needs_cookie":
            add_item("needs_cookie", "字幕层需要登录态", "warning", "当前公开视频链路拿不到完整字幕，继续整理前最好先补 Cookie。")
        elif capture_status == "needs_asr":
            add_item("needs_asr", "仍缺可用正文", "warning", "当前还没有拿到可直接使用的正文层，更适合先补转写。")
        elif capture_status == "asr_failed":
            add_item("asr_failed", "转写链路未完成", "warning", "字幕和转写都还没有稳定返回可用正文。")
        elif capture_status == "limited":
            add_item("limited", "当前仅有基础档案", "warning", "目前保留的仍是弱材料，不适合直接当作完整笔记。")
        elif capture_status == "preview_ready":
            add_item("preview_ready", "当前仍是预览结果", "warning", "这条内容还没有完成正式解析与正文提取。")

        if transcript_source == "description":
            add_item("description_only", "仍以简介材料为主", "warning", "当前正文主要来自简介或基础档案，完整度通常不够稳。")
        elif transcript_source.startswith("asr") and noisy_asr_detected:
            add_item("noisy_asr", "转写噪声偏高", "warning", "当前转写可用，但语句切分和个别细节仍需要核对。")

        if is_video_like and not timestamps_available:
            add_item("missing_timestamps", "缺少稳定时间定位", "warning", "当前还不能稳定回跳到原视频片段。")
        elif is_video_like and timestamps_estimated:
            add_item("estimated_timestamps", "时间定位仍是估算值", "info", "当前可以回看，但关键结论最好再回原视频核对一次。")

        if is_video_like and timestamps_available and segment_count > 0 and seek_ready_count < max(1, min(segment_count, 2)):
            add_item("seek_links_partial", "回看链接还不完整", "info", "已经有时间片段，但部分定位还没有稳定可点击入口。")

        if is_video_like and segment_count <= 2:
            add_item("few_segments", "正文片段偏少", "warning", f"当前仅保留 {max(segment_count, 0)} 段正文片段，中段和尾段更容易缺失。")
        elif not is_video_like and len(content_text.strip()) < 240:
            add_item("short_body", "正文长度偏短", "info", "当前可用正文仍然偏少，更适合作为草稿而不是最终整理。")

        if len(content_text.strip()) < (240 if is_video_like else 180):
            add_item("thin_content", "正文密度偏弱", "info", "当前保留下来的正文还不够厚，后续总结时更容易丢条件。")

        top_labels = [item["label"] for item in items[:2]]
        summary = "当前采集链路稳定。"
        if top_labels:
            summary = f"当前仍有 {len(items)} 处采集缺口：{'、'.join(top_labels)}。"

        return {
            "blocked": self._is_capture_blocked(capture_status),
            "gap_count": len(items),
            "summary": summary,
            "items": items,
        }

    def _build_note_coverage_report(
        self,
        *,
        semantic_units: list[dict[str, Any]],
        refined_note: str,
        summary: str,
        key_points: list[Any],
    ) -> dict[str, Any]:
        total_units = len(semantic_units)
        if total_units <= 0:
            return {
                "coverage_ratio": 0.0,
                "covered_units": 0,
                "total_units": 0,
                "summary": "当前没有足够的章节线索来判断覆盖度。",
                "missing_positions": [],
                "missing_sections": [],
            }

        note_source = "\n".join(
            [
                summary.strip(),
                *[str(item).strip() for item in key_points if str(item).strip()],
                refined_note.strip(),
            ]
        ).strip()
        note_signals = self._build_overlap_signals(note_source)

        covered_units = 0
        missing_sections: list[dict[str, str]] = []
        for unit in semantic_units:
            unit_text = str(unit.get("text") or "").strip()
            unit_signals = self._build_overlap_signals(unit_text)
            overlap_hits = len(note_signals & unit_signals)
            if unit_signals:
                if len(unit_signals) <= 6:
                    required_hits = 1
                elif len(unit_signals) <= 14:
                    required_hits = 2
                else:
                    required_hits = 3
            else:
                required_hits = 1

            if overlap_hits >= required_hits:
                covered_units += 1
                continue

            missing_sections.append(
                {
                    "label": str(unit.get("label") or "待补片段"),
                    "position": str(unit.get("position") or "待补内容"),
                    "excerpt": self._truncate_excerpt(unit_text, 42),
                }
            )

        coverage_ratio = covered_units / max(total_units, 1)
        missing_positions = list(dict.fromkeys(item["position"] for item in missing_sections if item.get("position")))
        if coverage_ratio >= 0.8:
            summary_text = f"笔记已经覆盖大部分关键段落，当前命中 {covered_units} / {total_units} 段。"
        elif missing_positions:
            summary_text = f"笔记当前命中 {covered_units} / {total_units} 段，更可能遗漏：{'、'.join(missing_positions[:2])}。"
        else:
            summary_text = f"笔记当前命中 {covered_units} / {total_units} 段。"

        return {
            "coverage_ratio": round(coverage_ratio, 4),
            "covered_units": covered_units,
            "total_units": total_units,
            "summary": summary_text,
            "missing_positions": missing_positions,
            "missing_sections": missing_sections[:4],
        }

    def _build_overlap_signals(self, text: str) -> set[str]:
        signals: set[str] = set()
        compact = re.sub(r"\s+", "", str(text or "").lower())
        if not compact:
            return signals

        for token in re.findall(r"[a-z0-9]{3,}", compact):
            signals.add(token)
            if len(signals) >= 80:
                return signals

        for token in re.findall(r"[\u4e00-\u9fff]{2,}", compact):
            if len(token) <= 3:
                signals.add(token)
            else:
                for index in range(len(token) - 1):
                    signals.add(token[index:index + 2])
                    if len(signals) >= 80:
                        return signals
                signals.add(token[:4])
                signals.add(token[-4:])
                if len(signals) >= 80:
                    return signals
        return signals

    def _truncate_excerpt(self, text: str, limit: int) -> str:
        compact = re.sub(r"\s+", " ", str(text or "")).strip()
        if len(compact) <= limit:
            return compact
        return compact[:limit].rstrip() + "…"

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
        accuracy_score: int,
        coverage_score: int,
        note_structure_score: int,
        capture_gap_report: dict[str, Any],
        note_coverage_report: dict[str, Any],
    ) -> str:
        if accuracy_score < 56:
            capture_focus = self._format_report_labels(capture_gap_report.get("items"), limit=2)
            if capture_focus:
                return f"当前已经拿到基础内容，但采集链路还存在 {capture_focus}，更适合先核稳来源和正文，再继续做高置信成稿。"
            return "当前已经拿到基础内容，但采集可靠性还偏弱，更适合先核稳来源和正文，再继续做高置信成稿。"
        if coverage_score < 56:
            missing_focus = self._format_missing_positions(note_coverage_report)
            if missing_focus:
                return f"当前内容已经形成基础整理，但正文覆盖度还不够稳，当前更可能遗漏 {missing_focus}，更适合作为补齐前的草稿。"
            return "当前内容已经形成基础整理，但正文覆盖度还不够稳，容易漏掉关键段和中段条件，更适合作为补齐前的草稿。"
        if note_structure_score < 56:
            return "当前笔记已经有核心信息，但结构、断句和段落组织还不够规整，适合继续做一次成稿整理后再作为最终笔记。"
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
        accuracy_score: int,
        coverage_score: int,
        note_structure_score: int,
        capture_gap_report: dict[str, Any],
        note_coverage_report: dict[str, Any],
    ) -> str:
        if accuracy_score < 56:
            capture_focus = self._format_report_labels(capture_gap_report.get("items"), limit=2)
            if capture_focus:
                return f"优先补稳正文来源，先处理 {capture_focus}，再继续做高质量成稿会更稳。"
            return "优先补稳正文来源，确认是字幕、网页正文还是转写恢复，再继续做高质量成稿。"
        if coverage_score < 56:
            missing_focus = self._format_missing_positions(note_coverage_report)
            if missing_focus:
                return f"优先补齐正文覆盖度，先把 {missing_focus} 补稳，再进行总结和问答会更稳。"
            return "优先补齐正文覆盖度，尤其是中段、结尾和关键条件，再进行总结和问答会更稳。"
        if note_structure_score < 56:
            return "优先再做一次成稿整理，把长句拆开、段落补齐、重复压掉，再把当前笔记当作最终版本。"
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
            "accuracy": "采集可靠",
            "coverage": "内容完整",
            "note_structure": "笔记规范",
        }
        suffix = "已就绪" if ready else "待加强"
        return f"{name_map.get(name, name)}{state}，{suffix}"

    def _format_report_labels(self, raw_items: Any, *, limit: int) -> str:
        if not isinstance(raw_items, list):
            return ""
        labels = [
            str(item.get("label") or "").strip()
            for item in raw_items
            if isinstance(item, dict) and str(item.get("label") or "").strip()
        ]
        deduped = list(dict.fromkeys(labels))
        return "、".join(deduped[:limit])

    def _format_missing_positions(self, note_coverage_report: dict[str, Any]) -> str:
        raw_positions = note_coverage_report.get("missing_positions")
        if not isinstance(raw_positions, list):
            return ""
        positions = [str(item).strip() for item in raw_positions if str(item).strip()]
        deduped = list(dict.fromkeys(positions))
        return "、".join(deduped[:2])

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
