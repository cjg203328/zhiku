from __future__ import annotations

import re
from typing import Any


WEAK_CAPTURE_STATUSES = {"needs_cookie", "needs_asr", "asr_failed", "limited", "preview_ready"}
PROMOTIONAL_PATTERNS = (
    re.compile(r"(?:点击|记得|欢迎|麻烦|帮忙).{0,8}(?:关注|点赞|收藏|投币|三连)"),
    re.compile(r"(?:评论区|置顶|下方|下边|简介区|简介里).{0,12}(?:链接|领取|查看|获取|报名|课程|资料|福利)"),
    re.compile(r"(?:直播|训练营|社群|粉丝群|知识星球|公众号|私信|加微|微信|vx|qq群|群聊)"),
    re.compile(r"(?:课程介绍|介绍一下.{0,8}课程|报名|优惠|折扣|福利|下单|购买|咨询|预约|体验课|陪跑)"),
    re.compile(r"(?:课程中相见|课程里见|训练营里见|直播间见|下节课见|我们课上见|拜拜)$"),
)
LOW_SIGNAL_POINT_PREFIXES = ("后续优先", "建议下一步", "当前说明", "当前材料状态", "当前正文来源", "已先整理出主题线索")


class InitialMaterialService:
    def prepare(self, payload: dict[str, Any]) -> None:
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        capture_status = str(payload.get("status") or metadata.get("capture_status") or "").strip().lower()
        summary = str(payload.get("summary") or "").strip()
        content_text = str(payload.get("content_text") or "").strip()
        title = str(payload.get("title") or "").strip() or "未命名内容"
        author = str(payload.get("author") or "").strip()
        platform = str(payload.get("platform") or "").strip()
        tags = [str(item).strip() for item in (payload.get("tags") or []) if str(item).strip()]

        description = self._clean_source_text(str(metadata.get("source_description") or "").strip())
        capture_summary = str(metadata.get("capture_summary") or "").strip()
        capture_action = str(metadata.get("capture_recommended_action") or "").strip()
        transcript_source = str(metadata.get("transcript_source") or "").strip() or "unknown"

        seed_points = self._build_seed_points(
            title=title,
            description=description,
            summary=summary,
            capture_summary=capture_summary,
        )
        seed_queries = self._build_seed_queries(title=title, tags=tags, seed_points=seed_points)
        seed_markdown = self._build_seed_markdown(
            title=title,
            author=author,
            platform=platform,
            transcript_source=transcript_source,
            capture_summary=capture_summary,
            capture_action=capture_action,
            seed_points=seed_points,
            seed_queries=seed_queries,
        )
        seed_text = self._build_seed_text(
            title=title,
            author=author,
            platform=platform,
            transcript_source=transcript_source,
            capture_summary=capture_summary,
            capture_action=capture_action,
            seed_points=seed_points,
        )

        metadata["material_seed_ready"] = bool(seed_points)
        metadata["material_seed_points"] = seed_points
        metadata["material_seed_queries"] = seed_queries
        metadata["material_seed_markdown"] = seed_markdown
        metadata["material_seed_summary"] = self._build_seed_summary(title=title, capture_summary=capture_summary, seed_points=seed_points)
        metadata["material_seed_level"] = "weak_capture" if capture_status in WEAK_CAPTURE_STATUSES else "baseline"
        payload["metadata"] = metadata

        if capture_status not in WEAK_CAPTURE_STATUSES:
            return

        if seed_text and len(seed_text) > len(content_text):
            payload["content_text"] = seed_text

        if seed_points:
            payload["key_points"] = seed_points[:4]

        payload["summary"] = self._build_seed_summary(
            title=title,
            capture_summary=capture_summary or summary,
            seed_points=seed_points,
        )

    def _build_seed_summary(self, *, title: str, capture_summary: str, seed_points: list[str]) -> str:
        lead = capture_summary.strip() or f"《{title}》当前只拿到了有限材料。"
        if seed_points:
            focus = re.sub(r"^主题焦点：", "", seed_points[0]).strip().rstrip("。")
            focus = re.sub(r"[！？!?]+", "", focus)
            if focus:
                return f"{lead} 当前可以先关注：{focus}。"
        return lead

    def _build_seed_points(
        self,
        *,
        title: str,
        description: str,
        summary: str,
        capture_summary: str,
    ) -> list[str]:
        points: list[str] = []
        if title.strip():
            points.append(f"主题焦点：{title.strip()}")

        source_text = "\n".join(
            item for item in [description, summary, capture_summary] if item.strip()
        ).strip()
        candidates = self._extract_candidate_sentences(source_text)
        for item in candidates:
            if item not in points:
                points.append(item)
            if len(points) >= 3:
                break

        deduped: list[str] = []
        for item in points:
            cleaned = self._normalize_point(item)
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:4]

    def _build_seed_queries(self, *, title: str, tags: list[str], seed_points: list[str]) -> list[str]:
        topic = tags[0] if tags else title[:12]
        queries = [
            f"{title} 主要观点是什么？",
            f"{topic} 这条内容里最值得核对的结论是什么？",
        ]
        if seed_points:
            first_point = re.sub(r"^主题焦点：", "", seed_points[0]).strip()
            if first_point:
                queries.append(f"围绕“{first_point}”还能继续追问什么？")

        deduped: list[str] = []
        for item in queries:
            cleaned = re.sub(r"\s+", " ", item).strip()
            if cleaned and cleaned not in deduped:
                deduped.append(cleaned)
        return deduped[:3]

    def _build_seed_markdown(
        self,
        *,
        title: str,
        author: str,
        platform: str,
        transcript_source: str,
        capture_summary: str,
        capture_action: str,
        seed_points: list[str],
        seed_queries: list[str],
    ) -> str:
        lines = [
            f"# {title}",
            "",
            "## 初步材料整理",
            "",
            f"- 平台: {platform or '-'}",
            f"- 作者: {author or '-'}",
            f"- 当前正文来源: {transcript_source or '-'}",
            f"- 当前材料状态: {capture_summary or '仅拿到有限线索'}",
        ]
        if capture_action:
            lines.append(f"- 建议下一步: {capture_action}")
        lines.append("")
        lines.append("## 当前可用线索")
        lines.append("")
        if seed_points:
            lines.extend([f"- {item}" for item in seed_points])
        else:
            lines.append("- 当前还没有足够线索形成初步整理。")
        if seed_queries:
            lines.extend(["", "## 适合继续追问", ""])
            lines.extend([f"- {item}" for item in seed_queries])
        return "\n".join(lines).strip()

    def _build_seed_text(
        self,
        *,
        title: str,
        author: str,
        platform: str,
        transcript_source: str,
        capture_summary: str,
        capture_action: str,
        seed_points: list[str],
    ) -> str:
        lines = [
            f"主题：{title}",
            f"平台：{platform or '-'}",
            f"作者：{author or '-'}",
            f"当前正文来源：{transcript_source or '-'}",
            f"材料状态：{capture_summary or '仅拿到有限线索'}",
        ]
        if seed_points:
            lines.append("当前可用线索：")
            lines.extend([f"- {item}" for item in seed_points])
        if capture_action:
            lines.append(f"建议下一步：{capture_action}")
        return "\n".join(lines).strip()

    def _extract_candidate_sentences(self, text: str) -> list[str]:
        if not text.strip():
            return []

        items = [
            self._clean_source_text(item)
            for item in re.split(r"[\n。！？!?；;]", text)
        ]
        scored: list[tuple[int, str]] = []
        for item in items:
            if len(item) < 10:
                continue
            if self._looks_like_promotional_copy(item):
                continue
            score = min(len(item), 42)
            if 16 <= len(item) <= 68:
                score += 10
            if re.search(r"\d", item):
                score += 4
            if any(token in item for token in ("核心", "关键", "问题", "行业", "策略", "AI", "独立游戏", "3A", "趋势", "发布", "上线", "功能", "模型")):
                score += 8
            if any(token in item for token in ("http", "BV", "合作", "商务", "链接", "转发")):
                score -= 16
            if item.endswith(("吗", "呢", "？", "?")):
                score -= 4
            scored.append((score, item))

        ordered = sorted(scored, key=lambda row: (-row[0], row[1]))
        picked: list[str] = []
        for _, item in ordered:
            if any(item in existing or existing in item for existing in picked):
                continue
            polished = self._polish_sentence(item)
            if not polished:
                continue
            picked.append(polished)
            if len(picked) >= 3:
                break
        return picked

    def _clean_source_text(self, text: str) -> str:
        cleaned = re.sub(r"https?://\S+", " ", text or "")
        cleaned = re.sub(r"BV[0-9A-Za-z]+", " ", cleaned)
        cleaned = re.sub(r"[#@]", " ", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        return cleaned

    def _normalize_point(self, text: str) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip(" -:：;；，,。")
        if len(cleaned) < 6:
            return ""
        if any(cleaned.startswith(prefix) for prefix in LOW_SIGNAL_POINT_PREFIXES):
            return ""
        if self._looks_like_promotional_copy(cleaned):
            return ""
        return self._polish_sentence(cleaned)

    def _looks_like_promotional_copy(self, text: str) -> bool:
        normalized = re.sub(r"\s+", "", text or "").lower()
        if not normalized:
            return False
        if any(normalized.startswith(prefix) for prefix in LOW_SIGNAL_POINT_PREFIXES):
            return True
        if any(pattern.search(normalized) for pattern in PROMOTIONAL_PATTERNS):
            return True

        cta_hits = sum(
            token in normalized
            for token in ("关注", "点赞", "收藏", "投币", "三连", "评论区", "置顶", "下方", "链接", "私信")
        )
        if cta_hits >= 2:
            return True

        has_sales_topic = any(token in normalized for token in ("课程", "训练营", "社群", "报名", "优惠", "福利"))
        has_sales_action = any(token in normalized for token in ("链接", "置顶", "评论区", "领取", "咨询", "购买", "下单"))
        return has_sales_topic and has_sales_action

    def _polish_sentence(self, text: str) -> str:
        cleaned = re.sub(r"\s+", " ", text or "").strip()
        if not cleaned:
            return ""

        if re.search(r"[\u4e00-\u9fff]", cleaned):
            cleaned = cleaned.replace(",", "，")
            cleaned = cleaned.replace(";", "；")
            cleaned = cleaned.replace("?", "？")
            cleaned = cleaned.replace("!", "！")
            cleaned = re.sub(r"(?<=[\u4e00-\u9fff]):(?=[\u4e00-\u9fffA-Za-z0-9])", "：", cleaned)
            cleaned = self._restore_missing_punctuation(cleaned)
            cleaned = "".join(self._split_overlong_sentences(cleaned)).strip() or cleaned

        cleaned = re.sub(r"\s*([，。！？；：])\s*", r"\1", cleaned)
        cleaned = re.sub(r"([，。！？；：…])\1+", r"\1", cleaned)
        cleaned = cleaned.strip(" -")
        if cleaned and cleaned[-1] not in "。！？；…":
            cleaned += "。"
        return cleaned

    def _split_overlong_sentences(self, text: str, *, hard_cap: int = 70) -> list[str]:
        parts = [item.strip() for item in re.split(r"(?<=[。！？；])\s*", text) if item.strip()]
        if not parts:
            return []

        sentences: list[str] = []
        connector_pattern = (
            r"(?<=[\u4e00-\u9fffA-Za-z0-9）】」])"
            r"(?=(?:但是|不过|然而|所以|因此|另外|同时|接下来|随后|最后|总之|换句话说|这也说明|这意味着|"
            r"首先|其次|其中|尤其|比如|例如|其实|现在|这就是|问题是|更重要的是))"
        )
        for part in parts:
            if len(part) <= hard_cap:
                sentences.append(part)
                continue
            terminal = part[-1] if part[-1] in "。！？；" else "。"
            body = part[:-1].strip() if part[-1] in "。！？；" else part
            clauses = [item.strip() for item in re.split(r"(?<=[，；])", body) if item.strip()]
            if len(clauses) <= 1:
                clauses = [item.strip() for item in re.split(connector_pattern, body) if item.strip()]
            if len(clauses) <= 1:
                clauses = [item.strip() for item in re.findall(r".{1,30}", body) if item.strip()]

            buffer = ""
            for clause in clauses:
                normalized_clause = clause.lstrip("，；、").strip()
                if not normalized_clause:
                    continue
                candidate = f"{buffer}{normalized_clause}" if buffer.endswith(("，", "；")) else (f"{buffer}，{normalized_clause}" if buffer else normalized_clause)
                if buffer and len(candidate) > hard_cap:
                    sentences.append(self._ensure_sentence_terminal(buffer, "。"))
                    buffer = normalized_clause
                    continue
                buffer = candidate
            if buffer:
                sentences.append(self._ensure_sentence_terminal(buffer, terminal))
        return [item for item in sentences if item]

    def _ensure_sentence_terminal(self, text: str, terminal: str = "。") -> str:
        cleaned = text.strip().rstrip("，；、,; ")
        if not cleaned:
            return ""
        if cleaned.endswith(("。", "！", "？", "；", "...", "…")):
            return cleaned
        return f"{cleaned}{terminal}"

    def _restore_missing_punctuation(self, text: str) -> str:
        compact = re.sub(r"\s+", " ", text or "").strip()
        if len(compact) < 28:
            return compact

        punctuation_count = len(re.findall(r"[，。！？；：、“”,.!?;:]", compact))
        punctuation_density = punctuation_count / max(len(compact), 1)
        if punctuation_density >= 0.014:
            return compact

        repaired = compact
        repaired = re.sub(
            r"(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:但是|不过|然而|所以|因此|另外|同时|接下来|最后|总之|换句话说))",
            "。",
            repaired,
        )
        repaired = re.sub(
            r"(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:而是|因为|如果|并且|而且|其中|尤其|比如|例如))",
            "，",
            repaired,
        )
        repaired = re.sub(
            r"(?<=[\u4e00-\u9fffA-Za-z0-9）】」])(?=(?:这就是|问题是|更重要的是|核心在于|现在|随后|接着))",
            "。",
            repaired,
        )
        if not re.search(r"[。！？；]", repaired) and len(repaired) >= 72:
            chunks = [item.strip() for item in re.findall(r".{1,28}", repaired) if item.strip()]
            if len(chunks) > 1:
                repaired = "".join(
                    f"{chunk}{'。' if index == len(chunks) - 1 else '，'}"
                    if chunk[-1] not in "，。！？；"
                    else chunk
                    for index, chunk in enumerate(chunks)
                )
        return repaired
