from __future__ import annotations

from dataclasses import dataclass
import json
import re
import time
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit

from ..config import AppSettings

try:
    import opencc
    _opencc_converter = opencc.OpenCC("t2s")
    def _to_simplified(text: str) -> str:
        return _opencc_converter.convert(text)
except Exception:
    _opencc_converter = None
    _TRADITIONAL_TO_SIMPLIFIED_FALLBACK = str.maketrans(
    {
        "體": "体",
        "說": "说",
        "這": "这",
        "個": "个",
        "為": "为",
        "們": "们",
        "來": "来",
        "時": "时",
        "會": "会",
        "後": "后",
        "對": "对",
        "開": "开",
        "發": "发",
        "點": "点",
        "與": "与",
        "關": "关",
        "於": "于",
        "進": "进",
        "還": "还",
        "讓": "让",
        "種": "种",
        "裡": "里",
        "從": "从",
        "將": "将",
        "給": "给",
        "該": "该",
        "實": "实",
        "現": "现",
        "業": "业",
        "題": "题",
        "問": "问",
        "學": "学",
        "習": "习",
        "產": "产",
        "結": "结",
        "構": "构",
        "轉": "转",
        "寫": "写",
        "識": "识",
        "錄": "录",
        "檢": "检",
        "索": "索",
        "維": "维",
        "護": "护",
        "網": "网",
        "頁": "页",
        "補": "补",
        "強": "强",
        "簡": "简",
        "穩": "稳",
        "變": "变",
        "應": "应",
        "盡": "尽",
        "擇": "择",
        "斷": "断",
        "報": "报",
        "錯": "错",
        "誤": "误",
        "達": "达",
        "標": "标",
        "啟": "启",
        "動": "动",
        "環": "环",
        "測": "测",
        "試": "试",
        "輸": "输",
        "優": "优",
        "勢": "势",
        "範": "范",
        "圍": "围",
        "參": "参",
        "數": "数",
        "價": "价",
        "值": "值",
        "資": "资",
        "訊": "讯",
        "書": "书",
        "圖": "图",
        "選": "选",
        "擴": "扩",
        "縮": "缩",
        "壓": "压",
        "線": "线",
        "區": "区",
        "門": "门",
        "務": "务",
        "國": "国",
        "專": "专",
        "術": "术",
        "號": "号",
        "級": "级",
        "層": "层",
        "處": "处",
        "際": "际",
        "驗": "验",
        "證": "证",
        "據": "据",
        "舊": "旧",
        "壞": "坏",
        "話": "话",
        "貢": "贡",
        "獻": "献",
        "總": "总",
        "結": "结",
        "廣": "广",
        "嗎": "吗",
    })
    def _to_simplified(text: str) -> str:
        return text.translate(_TRADITIONAL_TO_SIMPLIFIED_FALLBACK)


@dataclass
class LlmResult:
    text: str
    provider: str
    model: str


class LlmGatewayError(RuntimeError):
    def __init__(self, message: str, *, classification: str, http_status: int | None = None) -> None:
        super().__init__(message)
        self.classification = classification
        self.http_status = http_status


class LlmGateway:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings

    def is_enabled(self) -> bool:
        return self.settings.llm_enabled

    def generate_answer(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        quality: dict[str, Any] | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
        query_intent: str | None = None,
    ) -> LlmResult | None:
        if not self.is_enabled() or not matches:
            return None

        context_blocks: list[str] = []
        for index, item in enumerate(matches[:5], start=1):
            title = item.get("title") or "未命名内容"
            heading = item.get("heading") or f"片段 {index}"
            time_label = self._format_time_range(item.get("start_ms"), item.get("end_ms"))
            lines = [f"[{index}] 标题：{title}", f"片段：{heading}"]
            if time_label:
                lines.append(f"时间：{time_label}")
            evidence_excerpt = self._build_match_excerpt(item)
            if evidence_excerpt:
                lines.append(f"内容：{evidence_excerpt}")
            context_blocks.append("\n".join(lines))

        conversation_block = self._build_conversation_block(
            conversation_context,
            heading="你还可以参考最近几轮上下文",
        )

        intent_label = self._describe_query_intent(query_intent)
        intent_instruction = self._build_intent_instruction(query_intent)
        role_instruction = self._build_answer_role_instruction(
            query_intent=query_intent,
            quality=quality,
        )
        prompt = (
            conversation_block
            + f"问题：{query}\n\n"
            + f"回答方向：{intent_instruction}\n\n"
            + f"当前职责：{role_instruction}\n\n"
            + "参考资料：\n"
            + "\n\n".join(context_blocks)
            + "\n\n直接用中文回答，全部中文内容使用简体中文，不要出现繁体字。不要重复问题，不要写‘根据资料’这类前缀。"
            "如果资料有视频时间点，可自然提示回看。追问时接着上一轮说，不要重铺背景。"
            "问题简单时，可以用轻微拟人化、像人在当面交流的自然口吻，保持简洁，不要油腻或堆语气词。"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.2,
                system_prompt="你是一个帮用户理解和提炼内容的助手。证据明确时你负责整理、归纳、汇总和输出；问题复杂时你要先完成判断，再直接给最终答案。简单问题可更像真人对话，复杂问题要继续保持清晰结构。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return LlmResult(text=text, provider=self.settings.model_provider, model=self.settings.chat_model)

    def generate_scoped_content_answer(
        self,
        query: str,
        content: dict[str, Any],
        matches: list[dict[str, Any]],
        *,
        quality: dict[str, Any] | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
        query_intent: str | None = None,
    ) -> LlmResult | None:
        if not self.is_enabled() or not content:
            return None

        metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
        note_quality = metadata.get("note_quality") if isinstance(metadata.get("note_quality"), dict) else {}
        title = str(content.get("title") or "未命名内容").strip()
        summary = str(content.get("summary") or "").strip()
        content_type = str(content.get("content_type") or "").strip()
        transcript_source = str(metadata.get("transcript_source") or "").strip() or "unknown"
        refined_note = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
        key_points = [str(item).strip() for item in (content.get("key_points") or []) if str(item).strip()][:5]

        note_block_lines = []
        if summary:
            note_block_lines.append(f"摘要：{summary}")
        if key_points:
            note_block_lines.append("提炼要点：")
            note_block_lines.extend([f"- {item}" for item in key_points])
        if refined_note:
            note_block_lines.extend(["精炼笔记：", refined_note[:3200]])
        note_block = "\n".join(note_block_lines).strip()
        if not note_block and not matches:
            return None

        evidence_blocks: list[str] = []
        for index, item in enumerate(matches[:5], start=1):
            route_type = str(item.get("route_type") or "chunk").strip()
            heading = item.get("heading") or f"片段 {index}"
            chunk_metadata = item.get("chunk_metadata") if isinstance(item.get("chunk_metadata"), dict) else {}
            start_ms = chunk_metadata.get("start_ms")
            end_ms = chunk_metadata.get("end_ms")
            try:
                start_ms = int(start_ms) if start_ms is not None else None
            except (TypeError, ValueError):
                start_ms = None
            try:
                end_ms = int(end_ms) if end_ms is not None else None
            except (TypeError, ValueError):
                end_ms = None
            time_label = self._format_time_range(start_ms, end_ms)
            anchor_label = "精炼层" if route_type == "note" else "证据片段"
            lines = [f"[{index}] {anchor_label}：{heading}"]
            if time_label:
                lines.append(f"时间：{time_label}")
            evidence_excerpt = self._build_match_excerpt(item, max_length=260)
            if evidence_excerpt:
                lines.append(f"证据：{evidence_excerpt}")
            evidence_blocks.append("\n".join(lines))

        conversation_block = self._build_conversation_block(
            conversation_context,
            heading="最近几轮上下文",
        )

        quality_summary = str((quality or {}).get("summary") or "").strip()
        semantic_score = note_quality.get("semantic_score", (quality or {}).get("semantic_score"))
        content_kind = "视频" if content_type == "video" else "文章" if content_type == "article" else "内容"
        intent_label = self._describe_query_intent(query_intent)
        intent_instruction = self._build_intent_instruction(query_intent)
        role_instruction = self._build_answer_role_instruction(
            query_intent=query_intent,
            quality=quality,
        )

        prompt = (
            f"这是一条{content_kind}内容：《{title}》\n"
            + (f"\n摘要和要点：\n{note_block}\n" if note_block else "")
            + ("\n相关片段：\n" + "\n\n".join(evidence_blocks) + "\n" if evidence_blocks else "")
            + f"\n{conversation_block}"
            + f"问题：{query}\n\n"
            + f"回答方向：{intent_instruction}\n\n"
            + f"当前职责：{role_instruction}\n\n"
            + "直接用中文回答，全部中文内容使用简体中文，不要出现繁体字。"
            + ("如果是视频，可指出大概时间点方便回看。" if content_kind == "视频" else "")
            + ("\n注意：正文来自音频转写，个别细节可能有误，不确定的说清楚即可。" if transcript_source == "asr" else "")
            + "\n不要重复问题，不要写套话开头，追问时接着上一轮说。"
            + "问题简单时，可以用轻微拟人化、像人在当面交流的自然口吻，保持简洁，不要油腻或堆语气词。"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.2,
                system_prompt="你是一个帮用户理解视频和文章内容的助手。证据明确时你负责整理、归纳、汇总和输出；问题复杂时你要先完成判断，再直接给最终答案。回答直接、自然，不套模板。简单问题可以更像真人对话，复杂问题继续保持结构感。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return LlmResult(text=text, provider=self.settings.model_provider, model=self.settings.chat_model)

    def generate_general_answer(
        self,
        query: str,
        *,
        query_intent: str | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
    ) -> LlmResult | None:
        if not self.is_enabled() or not query.strip():
            return None

        intent_label = self._describe_query_intent(query_intent)
        intent_instruction = self._build_intent_instruction(query_intent)
        conversation_block = self._build_conversation_block(
            conversation_context,
            heading="最近几轮上下文",
        )
        prompt = (
            "当前知识库没有命中相关资料，请你基于通用常识直接回答用户问题。\n"
            "要求：\n"
            "1. 先给结论，再给理由或步骤。\n"
            "2. 回答要务实、清晰、易执行，不要空泛。\n"
            "3. 对不确定内容要明确标注为经验性建议，不要硬编。\n"
            "4. 尽量避免官样文章，保持自然中文表达。\n\n"
            "5. 不要使用省略号，不要堆空话，不要重复同一个意思。\n"
            "6. 如果这是追问，优先承接上一轮继续往下答，不要把已经说过的总览完整重写一遍。\n"
            "7. 如果上下文里已经有上一轮结论，这一轮第一句直接切到新的问题点，不要重铺背景。\n\n"
            "8. 全部中文内容使用简体中文，不要出现繁体字。\n\n"
            "9. 如果问题本身很简单，可以用轻微拟人化、像人在当面交流的口吻直接回答，但不要油腻或堆语气词。\n\n"
            f"当前用户意图：{intent_label}\n"
            f"回答结构建议：{intent_instruction}\n\n"
            + conversation_block
            + f"用户问题：{query}\n\n"
            "请直接输出中文答案，不要输出 JSON，不要写多余前言。"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.35,
                system_prompt="你是一个直接回答问题的助手，语气自然，给实用建议，不套模板。简单问题可更像真人简短回应，复杂问题再展开。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return LlmResult(text=text, provider=self.settings.model_provider, model=self.settings.chat_model)

    def generate_weak_retrieval_answer(
        self,
        query: str,
        matches: list[dict[str, Any]],
        *,
        quality: dict[str, Any] | None = None,
        query_intent: str | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
    ) -> LlmResult | None:
        if not self.is_enabled() or not query.strip():
            return None

        hint_blocks: list[str] = []
        for index, item in enumerate(matches[:3], start=1):
            title = item.get("title") or "未命名内容"
            heading = item.get("heading") or f"片段 {index}"
            time_label = self._format_time_range(item.get("start_ms"), item.get("end_ms"))
            lines = [f"[{index}] 标题：{title}", f"弱线索：{heading}"]
            if time_label:
                lines.append(f"时间：{time_label}")
            evidence_excerpt = self._build_match_excerpt(item, max_length=180)
            if evidence_excerpt:
                lines.append(f"摘录：{evidence_excerpt}")
            hint_blocks.append("\n".join(lines))

        intent_label = self._describe_query_intent(query_intent)
        intent_instruction = self._build_intent_instruction(query_intent)
        retrieval_summary = str((quality or {}).get("summary") or "").strip()
        conversation_block = self._build_conversation_block(
            conversation_context,
            heading="最近几轮上下文",
        )
        prompt = (
            "当前知识库只命中到少量弱相关线索，不足以支撑基于资料的确定性回答。\n"
            "请优先依靠通用知识和稳妥推理回答用户问题。\n"
            "如果下面的线索确实有帮助，可以当成弱参考；如果关系不大，可以忽略，不要硬拼进答案。\n"
            "要求：\n"
            "1. 先给结论，再给理由、判断框架或步骤。\n"
            "2. 对依赖具体资料才能确认的细节，要明确标注为一般经验、常见做法，或提示需要继续核实。\n"
            "3. 不要把弱线索说成已经证实的事实，不要编造来源。\n"
            "4. 如果这是追问，优先承接上下文，但不要机械重复上一轮。\n"
            "5. 全部中文内容使用简体中文，不要出现繁体字。\n\n"
            "6. 如果问题本身很简单，可以用轻微拟人化、像人在当面交流的口吻回答，但不要油腻或堆语气词。\n\n"
            f"当前用户意图：{intent_label}\n"
            f"回答结构建议：{intent_instruction}\n"
            + (f"当前检索状态：{retrieval_summary}\n\n" if retrieval_summary else "\n")
            + ("弱相关线索：\n" + "\n\n".join(hint_blocks) + "\n\n" if hint_blocks else "")
            + conversation_block
            + f"用户问题：{query}\n\n"
            + "请直接输出中文答案，不要输出 JSON，不要写“根据弱检索结果”之类的前言。"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.3,
                system_prompt="你是一个谨慎、直接的中文助手。证据不足时要明确边界，优先给用户稳妥可执行的回答。简单问题可更像真人简短回应，复杂问题保持判断力。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return LlmResult(text=text, provider=self.settings.model_provider, model=self.settings.chat_model)

    def generate_web_search_answer(
        self,
        query: str,
        web_results: list[dict[str, Any]],
        *,
        local_matches: list[dict[str, Any]] | None = None,
        local_quality: dict[str, Any] | None = None,
        query_intent: str | None = None,
        conversation_context: list[dict[str, Any]] | None = None,
    ) -> LlmResult | None:
        if not self.is_enabled() or not query.strip() or not web_results:
            return None

        local_blocks: list[str] = []
        for index, item in enumerate((local_matches or [])[:3], start=1):
            title = item.get("title") or "未命名内容"
            heading = item.get("heading") or f"片段 {index}"
            excerpt = self._build_match_excerpt(item, max_length=180)
            lines = [f"[{index}] 标题：{title}", f"本地线索：{heading}"]
            if excerpt:
                lines.append(f"摘录：{excerpt}")
            local_blocks.append("\n".join(lines))

        web_blocks: list[str] = []
        for index, item in enumerate(web_results[:5], start=1):
            title = str(item.get("title") or "").strip() or f"结果 {index}"
            snippet = str(item.get("snippet") or "").strip()
            url = str(item.get("url") or "").strip()
            lines = [f"[{index}] 标题：{title}"]
            if snippet:
                lines.append(f"摘要：{snippet}")
            if url:
                lines.append(f"链接：{url}")
            web_blocks.append("\n".join(lines))

        conversation_block = self._build_conversation_block(
            conversation_context,
            heading="最近几轮上下文",
        )
        intent_label = self._describe_query_intent(query_intent)
        intent_instruction = self._build_intent_instruction(query_intent)
        retrieval_summary = str((local_quality or {}).get("summary") or "").strip()
        local_lead = (
            "先看本地知识库：当前只有弱相关线索，不能直接当成已证实结论。"
            if local_blocks
            else "当前本地知识库没有命中可直接支撑回答的资料。"
        )
        prompt = (
            f"{local_lead}\n"
            "现在允许你参考联网搜索结果补充回答，但必须遵守：\n"
            "1. 优先沿着本地内容的方向回答，不要让联网结果压过本地资料。\n"
            "2. 只有外部结果能补足的部分再补，不要把搜索摘要说成已经完全核实的事实。\n"
            "3. 先给结论，再给理由、步骤或边界。\n"
            "4. 对时效性或不确定内容要明确说清楚。\n"
            "5. 全部中文内容使用简体中文，不要出现繁体字。\n\n"
            f"当前用户意图：{intent_label}\n"
            f"回答结构建议：{intent_instruction}\n"
            + (f"本地检索状态：{retrieval_summary}\n\n" if retrieval_summary else "\n")
            + ("本地线索：\n" + "\n\n".join(local_blocks) + "\n\n" if local_blocks else "")
            + "联网搜索结果：\n"
            + "\n\n".join(web_blocks)
            + "\n\n"
            + conversation_block
            + f"用户问题：{query}\n\n"
            + "请直接输出中文答案，不要输出 JSON，不要写多余前言。简单问题可以更自然一点，但不要油腻。"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.3,
                system_prompt="你是一个本地知识库优先的中文助手。先吸收本地资料，再把联网搜索当成补充信息，最后给用户一版自然、稳妥的答案。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return LlmResult(text=text, provider=self.settings.model_provider, model=self.settings.chat_model)

    def generate_query_rewrites(self, query: str) -> list[str] | None:
        if not self.is_enabled() or not query.strip():
            return None

        prompt = (
            "你是中文知识库检索优化助手。"
            "请把用户问题改写成 2 到 3 条更适合检索的中文短句。"
            "保留核心主题，不要扩写成大段解释。"
            "输出 JSON，对象字段只有 rewrites，值为字符串数组。"
            "不要输出代码块。\n\n"
            f"用户问题：{query}"
        )
        try:
            text = self._chat(prompt, temperature=0.1)
        except LlmGatewayError:
            return None
        if not text:
            return None
        payload = self._parse_json_object_with_array(text, key="rewrites")
        if payload is None:
            return None
        return payload[:3]

    def enhance_import_result(
        self,
        *,
        title: str,
        author: str | None,
        source_url: str,
        content_text: str,
        note_style: str,
        summary_focus: str,
    ) -> dict[str, Any] | None:
        if not self.is_enabled():
            return None

        source = (content_text or "").strip()
        if len(source) < 40:
            return None

        truncated = source[:8000]
        style_instruction = ""
        if note_style == "bilinote":
            style_instruction = (
                "当笔记风格为 BiliNote 风格时，请让 summary 更像视频笔记开场摘要，"
                "让 key_points 更像“看完后最值得记住的几条内容”，"
                "整体语气偏成品笔记，方便直接阅读和复习。"
            )
        prompt = (
            "你是产品内的知识笔记整理助手，目标不是复述，而是把原始内容整理成真正对用户有用的笔记。\n"
            "请严格基于给定正文，不要编造原文没有的事实，不要补外部背景设定。\n"
            "允许去口语化、去重复、重组顺序，但不要丢掉关键条件、步骤、判断依据和限制。\n"
            "默认使用简体中文组织笔记、总结和标题。\n"
            "全部中文内容必须使用简体中文，不要使用繁体字。\n"
            "如果正文里出现英文专有名词、产品名、模型名、版本号、缩写或英文术语，保持原样显示，不要硬翻译，不要音译，不要改大小写。\n"
            "中文句子里引用英文词时，直接正常保留英文即可。\n"
            "不要在 note_markdown 里输出原始 URL、本地图片地址、截图 Markdown、静态资源路径或整段生硬转写。\n"
            "不要堆砌无关术语表，不要把元数据、播放量、点赞量、链接地址当成正文主体。\n"
            "正文层只保留真正影响理解、复盘和执行的内容，尽量写成自然可读的成品笔记。\n"
            "在输出之前先完成理解，再组织成稿；不要把原始转写直接压缩后塞进笔记。\n"
            "所有中文句子都要有清晰的停顿和标点，不要输出大段无标点长句。\n"
            "段落要有分层，每段尽量只承载一个核心意思，不要把多个判断硬挤在同一段里。\n"
            "如果一段里已经出现两个以上完整判断，请主动拆段；不要为了压缩篇幅牺牲句子边界。\n"
            "中文长句要主动拆成更自然的短句，优先保证阅读顺畅，再考虑压缩篇幅。\n"
            "不要输出采集状态、系统说明、下一步建议、继续提问提示、模型接入建议之类的过程性文案。\n"
            "笔记要更像“原生笔记的精炼版”，而不是说明书式缩略。\n"
            "输出必须是 JSON 对象，字段只有 summary、key_points、note_markdown，不要输出代码块。\n"
            "字段要求：\n"
            "- summary：1 到 2 句中文，像笔记开头的核心结论；必须是完整句子，标点明确，不要写采集状态、系统提示、后续建议。\n"
            "- key_points：3 到 5 条中文短句数组；每条都尽量写成独立、完整、可直接阅读的短句，避免无标点长串；优先保留策略、步骤、判断条件、注意事项、时间点；不要写“建议继续提问”“核对原视频”这类系统话术；其中识别到的英文术语正常保留。\n"
            "- note_markdown：适合详情页展示的中文 Markdown，必须包含以下二级标题：\n"
            "## 核心结论\n"
            "## 精炼正文\n"
            "## 重点摘录\n"
            "其中“核心结论”和“精炼正文”都必须写成自然段，不要整段只写一个超长句；单段尽量控制在 1 到 2 句；“重点摘录”里的每一条都要有明显停顿，避免像转写残片。\n"
            "如果正文不足，就明确写“当前正文不足，只能先保留已获取信息”，不要硬编。\n\n"
            f"{style_instruction}\n"
            f"标题：{title}\n"
            f"作者：{author or '-'}\n"
            f"链接：{source_url}\n"
            f"笔记风格：{note_style}\n"
            f"本次关注点：{summary_focus or '-'}\n\n"
            f"内容正文：\n{truncated}"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0.2,
                system_prompt="你是一个擅长提炼重点、整理结构并保留证据边界的中文知识整理助手。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None
        return self._parse_json_object(text)

    def repair_asr_transcript_lines(
        self,
        *,
        title: str,
        description: str,
        context_terms: list[str],
        lines: list[str],
    ) -> list[str] | None:
        if not self.is_enabled() or not lines:
            return None

        normalized_lines = [re.sub(r"\s+", " ", str(item or "")).strip() for item in lines]
        if not any(normalized_lines):
            return None

        visible_terms = [item.strip() for item in context_terms if item and item.strip()][:12]
        line_block = "\n".join(f"{index}. {item}" for index, item in enumerate(normalized_lines, start=1))
        prompt = (
            "任务：轻量修正 ASR 转写中的明显术语错误、英文专名、大小写、空格和标点。\n"
            "要求：\n"
            "1. 只修可以从标题、简介和候选术语中确认的内容。\n"
            "2. 不要总结，不要缩写，不要扩写，不要改写句意。\n"
            "3. 不确定的地方保留原句，宁可少改也不要乱改。\n"
            "4. 输出必须保持和输入完全相同的行数与顺序。\n"
            "5. 重点保留英文原词、英文短语、游戏名、产品名、缩写，不要替换成同音汉字。\n"
            "6. 中文内容统一使用简体中文，不要输出繁体字。\n"
            "7. 不要给每行加编号，不要输出解释，不要输出代码块。\n"
            '输出 JSON 对象，字段只有 lines，例如 {"lines":["...","..."]}。\n\n'
            f"标题：{title}\n"
            f"简介：{description or '-'}\n"
            f"候选术语：{'、'.join(visible_terms) if visible_terms else '-'}\n\n"
            "待修正文本：\n"
            f"{line_block}"
        )
        try:
            text = self._chat(
                prompt,
                temperature=0,
                system_prompt="你是一个谨慎的转写纠错助手，只做可确认的轻量修正。",
            )
        except LlmGatewayError:
            return None
        if not text:
            return None

        repaired = self._parse_json_object_with_array(text, key="lines")
        if not repaired or len(repaired) != len(lines):
            return None
        return [re.sub(r"\s+", " ", item).strip() for item in repaired]

    def probe_connection(self) -> dict[str, Any]:
        endpoint = self._resolve_chat_endpoint(self.settings.llm_api_base_url)
        if not self.is_enabled():
            return {
                "ok": False,
                "provider": self.settings.model_provider,
                "model": self.settings.chat_model,
                "endpoint": endpoint,
                "latency_ms": None,
                "classification": "config_error",
                "message": "主模型配置还不完整，请先检查接口地址、模型名和 API Key。",
                "response_preview": None,
                "http_status": None,
            }

        started_at = time.perf_counter()
        try:
            text = self._chat(
                "请只回复“连接成功”。",
                temperature=0,
                system_prompt="你是一个接口连通性测试助手。请只回复简短确认文本。",
            )
        except LlmGatewayError as exc:
            return {
                "ok": False,
                "provider": self.settings.model_provider,
                "model": self.settings.chat_model,
                "endpoint": endpoint,
                "latency_ms": round((time.perf_counter() - started_at) * 1000),
                "classification": exc.classification,
                "message": str(exc),
                "response_preview": None,
                "http_status": exc.http_status,
            }

        if not text:
            return {
                "ok": False,
                "provider": self.settings.model_provider,
                "model": self.settings.chat_model,
                "endpoint": endpoint,
                "latency_ms": round((time.perf_counter() - started_at) * 1000),
                "classification": "empty_response",
                "message": "接口连通成功，但当前没有返回可读文本，请检查模型名是否正确。",
                "response_preview": None,
                "http_status": None,
            }

        return {
            "ok": True,
            "provider": self.settings.model_provider,
            "model": self.settings.chat_model,
            "endpoint": endpoint,
            "latency_ms": round((time.perf_counter() - started_at) * 1000),
            "classification": "success",
            "message": "模型接口可用，当前配置已经能正常返回聊天结果。",
            "response_preview": text[:120],
            "http_status": 200,
        }

    def list_models(self) -> dict[str, Any]:
        endpoint = self._resolve_models_endpoint(self.settings.llm_api_base_url)
        if not self.settings.llm_api_base_url.strip():
            return {
                "ok": False,
                "endpoint": endpoint,
                "models": [],
                "message": "接口地址还未配置，暂时无法读取模型列表。",
            }

        headers = {}
        if self.settings.llm_api_key:
            headers["Authorization"] = f"Bearer {self.settings.llm_api_key}"
        headers["User-Agent"] = self._build_gateway_user_agent()
        headers["Accept"] = "application/json"
        req = urllib_request.Request(endpoint, headers=headers, method="GET")

        try:
            with urllib_request.urlopen(req, timeout=self.settings.llm_timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            if getattr(exc, "code", None) == 404:
                return {
                    "ok": False,
                    "endpoint": endpoint,
                    "models": [],
                    "message": "当前地址没有返回模型目录。若平台未开放 /models，可直接手填聊天模型名后再点“测试连接”；若文档要求填写到 /v1 层级，也请确认接口地址是否少了一段。",
                }
            error = self._build_gateway_error(exc)
            return {
                "ok": False,
                "endpoint": endpoint,
                "models": [],
                "message": str(error),
            }
        except URLError:
            return {
                "ok": False,
                "endpoint": endpoint,
                "models": [],
                "message": "读取模型列表失败，请检查接口地址、网络或代理设置。",
            }
        except TimeoutError:
            return {
                "ok": False,
                "endpoint": endpoint,
                "models": [],
                "message": "读取模型列表超时，请稍后再试。",
            }
        except json.JSONDecodeError:
            return {
                "ok": False,
                "endpoint": endpoint,
                "models": [],
                "message": "模型接口返回了无法解析的响应，请确认这是 OpenAI 兼容地址。",
            }

        items = payload.get("data")
        models: list[str] = []
        if isinstance(items, list):
            for item in items:
                if not isinstance(item, dict):
                    continue
                model_id = item.get("id")
                if isinstance(model_id, str) and model_id.strip():
                    models.append(model_id.strip())

        deduplicated = sorted(set(models), key=str.lower)
        return {
            "ok": bool(deduplicated),
            "endpoint": endpoint,
            "models": deduplicated,
            "message": "已读取模型列表。" if deduplicated else "接口可达，但当前没有返回可用模型列表。",
        }

    def _chat(
        self,
        prompt: str,
        *,
        temperature: float = 0.3,
        system_prompt: str = "你是一个专业的中文知识整理与问答助手。",
    ) -> str | None:
        endpoint = self._resolve_chat_endpoint(self.settings.llm_api_base_url)
        payload = {
            "model": self.settings.chat_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            "temperature": temperature,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.settings.llm_api_key}",
            "User-Agent": self._build_gateway_user_agent(),
            "Accept": "application/json, text/event-stream",
        }
        try:
            payload = self._request_chat_json(endpoint, payload, headers)
        except HTTPError as exc:
            body = self._read_http_error_body(exc)
            if self._should_retry_chat_with_stream(exc, body):
                return self._chat_with_stream(endpoint, payload, headers)
            raise self._build_gateway_error(exc, body=body) from exc
        except URLError as exc:
            raise LlmGatewayError("连接模型接口失败，请检查接口地址、网络或代理设置。", classification="network_error") from exc
        except TimeoutError as exc:
            raise LlmGatewayError("模型接口响应超时，请稍后再试，或检查网络与模型负载。", classification="timeout_error") from exc
        except json.JSONDecodeError as exc:
            raise LlmGatewayError("模型接口返回了无法解析的响应，请检查是否填错接口地址。", classification="invalid_response") from exc
        except Exception:
            return None

        return self._extract_chat_message_text(payload)

    def _request_chat_json(self, endpoint: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        data = json.dumps(payload).encode("utf-8")
        req = urllib_request.Request(endpoint, data=data, headers=headers, method="POST")
        with urllib_request.urlopen(req, timeout=self.settings.llm_timeout_seconds) as response:
            return json.loads(response.read().decode("utf-8"))

    def _chat_with_stream(self, endpoint: str, payload: dict[str, Any], headers: dict[str, str]) -> str | None:
        stream_payload = dict(payload)
        stream_payload["stream"] = True
        data = json.dumps(stream_payload).encode("utf-8")
        req = urllib_request.Request(endpoint, data=data, headers=headers, method="POST")
        try:
            with urllib_request.urlopen(req, timeout=self.settings.llm_timeout_seconds) as response:
                stream_text = response.read().decode("utf-8", errors="ignore")
        except HTTPError as exc:
            raise self._build_gateway_error(exc) from exc
        except URLError as exc:
            raise LlmGatewayError("连接模型接口失败，请检查接口地址、网络或代理设置。", classification="network_error") from exc
        except TimeoutError as exc:
            raise LlmGatewayError("模型接口响应超时，请稍后再试，或检查网络与模型负载。", classification="timeout_error") from exc
        except Exception:
            return None

        return self._extract_chat_stream_text(stream_text)

    def _extract_chat_message_text(self, payload: dict[str, Any]) -> str | None:
        choices = payload.get("choices") or []
        if not choices:
            return None
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, str):
            return self._normalize_llm_text(content)
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
            merged = "\n".join(parts).strip()
            return self._normalize_llm_text(merged) if merged else None
        return None

    def _extract_chat_stream_text(self, stream_text: str) -> str | None:
        parts: list[str] = []
        for raw_line in stream_text.splitlines():
            line = raw_line.strip()
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                payload = json.loads(data_str)
            except json.JSONDecodeError:
                continue
            choices = payload.get("choices") or []
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                delta_content = delta.get("content") if isinstance(delta, dict) else None
                if isinstance(delta_content, str) and delta_content:
                    parts.append(delta_content)
                    continue
                if isinstance(delta_content, list):
                    for item in delta_content:
                        if not isinstance(item, dict):
                            continue
                        text = item.get("text")
                        if isinstance(text, str) and text.strip():
                            parts.append(text.strip())
                message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
                content = message.get("content") if isinstance(message, dict) else None
                if isinstance(content, str) and content:
                    parts.append(content)
        merged = "".join(parts).strip()
        return self._normalize_llm_text(merged) if merged else None

    def _should_retry_chat_with_stream(self, exc: HTTPError, body: str) -> bool:
        http_status = getattr(exc, "code", None)
        if http_status != 400:
            return False
        lowered = body.lower()
        return "stream must be set to true" in lowered

    def _build_gateway_user_agent(self) -> str:
        return (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/136.0.0.0 Safari/537.36 Zhiku/0.1"
        )

    def _normalize_api_base_url(self, base_url: str) -> str:
        candidate = base_url.strip()
        if not candidate:
            return ""

        parsed = urlsplit(candidate)
        path = (parsed.path or "").rstrip("/")
        normalized_path = re.sub(
            r"/(?:chat/completions|responses|models|embeddings|audio/transcriptions)$",
            "",
            path,
            flags=re.IGNORECASE,
        ).rstrip("/")

        if parsed.scheme or parsed.netloc:
            return urlunsplit((parsed.scheme, parsed.netloc, normalized_path, "", ""))
        return normalized_path

    def _resolve_chat_endpoint(self, base_url: str) -> str:
        candidate = self._normalize_api_base_url(base_url)
        if not candidate:
            return ""
        return f"{candidate}/chat/completions"

    def _resolve_models_endpoint(self, base_url: str) -> str:
        candidate = self._normalize_api_base_url(base_url)
        if not candidate:
            return ""
        return f"{candidate}/models"

    def _parse_json_object(self, text: str) -> dict[str, Any] | None:
        candidate = text.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`")
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            payload = json.loads(candidate[start:end + 1])
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        summary = payload.get("summary")
        key_points = payload.get("key_points")
        note_markdown = payload.get("note_markdown") or payload.get("note") or payload.get("markdown")
        if not isinstance(summary, str) or not isinstance(note_markdown, str):
            return None
        normalized_points = self._normalize_string_array(key_points)
        if not normalized_points:
            return None
        return {
            "summary": self._normalize_llm_text(summary),
            "key_points": normalized_points[:6],
            "note_markdown": self._normalize_llm_text(note_markdown),
        }

    def _build_conversation_block(
        self,
        conversation_context: list[dict[str, Any]] | None,
        *,
        heading: str,
    ) -> str:
        if not conversation_context:
            return ""

        recent_messages = conversation_context[-6:]
        recent_user_messages = [
            item for item in recent_messages if item.get("role") == "user" and str(item.get("message_text") or "").strip()
        ]
        recent_assistant_messages = [
            item for item in recent_messages if item.get("role") == "assistant" and str(item.get("message_text") or "").strip()
        ]
        if not recent_user_messages and not recent_assistant_messages:
            return ""

        titles: list[str] = []
        for item in reversed(recent_messages):
            for title in self._extract_conversation_titles(item):
                if title and title not in titles:
                    titles.append(title)

        latest_user = (
            self._summarize_conversation_text(str(recent_user_messages[-1].get("message_text") or ""), role="用户")
            if recent_user_messages
            else ""
        )
        previous_user = (
            self._summarize_conversation_text(str(recent_user_messages[-2].get("message_text") or ""), role="用户")
            if len(recent_user_messages) >= 2
            else ""
        )
        latest_assistant = (
            self._summarize_conversation_text(str(recent_assistant_messages[-1].get("message_text") or ""), role="助手")
            if recent_assistant_messages
            else ""
        )

        lines = [f"{heading}："]
        if titles:
            lines.append(f"- 连续话题：{'、'.join(titles[:2])}")
        if latest_user:
            lines.append(f"- 上一轮用户问题：{latest_user}")
        if latest_assistant:
            lines.append(f"- 上一轮助手已回答到：{latest_assistant}")
        if previous_user and previous_user != latest_user:
            lines.append(f"- 更早一轮用户还问过：{previous_user}")
        lines.append("- 如果当前问题是在追问，只补新的判断、原因、步骤或边界，不要重写已经说过的总览。")
        return "\n".join(lines) + "\n\n"

    def _summarize_conversation_text(self, text: str, *, role: str) -> str:
        cleaned = str(text or "").replace("\r", "\n").strip()
        if not cleaned:
            return ""

        lines = [line.strip() for line in cleaned.split("\n") if line.strip()]
        merged = " ".join(lines)
        merged = re.sub(r"\s+", " ", merged).strip()
        if not merged:
            return ""

        merged = re.sub(r"^(?:结论|当前判断|建议下一步|通用回答|当前最接近的线索|目前只能参考的临时线索)[：:\s]*", "", merged)
        merged = re.sub(r"^(?:如果只看结论|简单说|更直接一点说|换句话说)[，,：:\s]*", "", merged)
        merged = merged.replace("……", "。")
        merged = re.sub(r"\.{3,}", "。", merged)

        if role == "助手":
            sentences = [item.strip() for item in re.split(r"(?<=[。！？!?；;])\s*", merged) if item.strip()]
            informative: list[str] = []
            for sentence in sentences:
                normalized = re.sub(r"^(?:结论|当前判断|建议下一步)[：:\s]*", "", sentence).strip()
                if not normalized:
                    continue
                if normalized not in informative:
                    informative.append(normalized)
            condensed = " ".join(informative[:2]).strip() or merged
            return condensed[:140].rstrip()
        return merged[:88].rstrip()

    def _extract_conversation_titles(self, item: dict[str, Any]) -> list[str]:
        titles: list[str] = []
        citations = item.get("citations")
        if isinstance(citations, list):
            for citation in citations:
                if not isinstance(citation, dict):
                    continue
                title = str(citation.get("title") or "").strip()
                if title and title not in titles:
                    titles.append(title)

        if titles:
            return titles[:3]

        text = str(item.get("message_text") or "").strip()
        for title in re.findall(r"《([^》]{2,40})》", text):
            cleaned = title.strip()
            if cleaned and cleaned not in titles:
                titles.append(cleaned)
        return titles[:3]

    def _build_match_excerpt(self, item: dict[str, Any], *, max_length: int = 220) -> str:
        summary_text = str(
            item.get("snippet")
            or item.get("chunk_summary")
            or item.get("summary")
            or ""
        ).strip()
        chunk_text = str(item.get("chunk_text") or "").strip().replace("\n", " ")
        chunk_text = " ".join(chunk_text.split())

        parts: list[str] = []
        if summary_text:
            parts.append(summary_text)
        if chunk_text:
            if not summary_text:
                parts.append(chunk_text)
            elif chunk_text[:40] not in summary_text:
                parts.append(f"原文摘录：{chunk_text}")

        merged = " ".join(part.strip() for part in parts if part and part.strip()).strip()
        if len(merged) <= max_length:
            return merged
        return merged[:max_length].rstrip() + "..."

    def _describe_query_intent(self, query_intent: str | None) -> str:
        mapping = {
            "summary": "总结提炼",
            "reason": "解释原因",
            "action": "给出做法",
            "compare": "比较差异",
            "decision": "辅助判断",
            "explain": "解释说明",
        }
        return mapping.get(str(query_intent or "").strip(), "解释说明")

    def _build_answer_role_instruction(
        self,
        *,
        query_intent: str | None = None,
        quality: dict[str, Any] | None = None,
    ) -> str:
        level = str((quality or {}).get("level") or "").strip().lower()
        if query_intent in {"reason", "compare", "decision"}:
            return "当前问题更偏判断与思考，请先完成取舍和归纳，再直接给最终答案，但不要脱离资料乱扩写。"
        if level in {"strong", "medium"}:
            return "当前检索证据已经比较明确，请把重点放在整理、归纳、汇总和清晰表达上，不要超出资料额外发挥。"
        return "请在不脱离已有资料的前提下做必要判断，直接回答用户真正关心的问题。"

    def _build_intent_instruction(self, query_intent: str | None) -> str:
        mapping = {
            "summary": "优先整理成 2 到 4 条真正可带走的结论，不要按命中顺序复述。",
            "reason": "先给判断，再解释最关键的原因和前提。",
            "action": "优先整理成可执行步骤或建议顺序，让人拿来就能用。",
            "compare": "并排讲清差异、适用条件和各自限制，不要混成一段。",
            "decision": "先给更稳妥的判断，再说依据、风险和适用边界。",
            "explain": "先把核心意思讲清楚，再补充细节、例子或限制。",
        }
        return mapping.get(str(query_intent or "").strip(), mapping["explain"])

    def _parse_json_object_with_array(self, text: str, *, key: str) -> list[str] | None:
        candidate = text.strip()
        if candidate.startswith("```"):
            candidate = candidate.strip("`")
            if candidate.lower().startswith("json"):
                candidate = candidate[4:].strip()
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return None
        try:
            payload = json.loads(candidate[start:end + 1])
        except json.JSONDecodeError:
            return None
        if not isinstance(payload, dict):
            return None
        value = payload.get(key)
        normalized = self._normalize_string_array(value)
        return normalized or None

    def _normalize_string_array(self, value: Any) -> list[str]:
        if isinstance(value, list):
            return [self._normalize_llm_text(item) for item in value if isinstance(item, str) and item.strip()]
        if isinstance(value, str):
            lines = [
                self._normalize_llm_text(item).lstrip("-•0123456789. ").strip()
                for item in value.splitlines()
                if item.strip()
            ]
            return [item for item in lines if item]
        return []

    def _normalize_llm_text(self, text: str) -> str:
        cleaned = str(text or "").strip()
        if not cleaned:
            return ""
        cleaned = _to_simplified(cleaned)
        cleaned = cleaned.replace("「", '"').replace("」", '"')
        cleaned = cleaned.replace("『", '"').replace("』", '"')
        return cleaned.strip()

    def _format_time_range(self, start_ms: Any, end_ms: Any) -> str:
        start_label = self._format_timestamp(start_ms)
        end_label = self._format_timestamp(end_ms)
        if start_label and end_label:
            return f"{start_label} - {end_label}"
        return start_label or end_label

    def _format_timestamp(self, value_ms: Any) -> str:
        try:
            milliseconds = int(value_ms)
        except (TypeError, ValueError):
            return ""
        if milliseconds < 0:
            return ""
        total_seconds = milliseconds // 1000
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _read_http_error_body(self, exc: HTTPError) -> str:
        try:
            return exc.read().decode("utf-8", errors="ignore")
        except Exception:
            return ""

    def _build_gateway_error(self, exc: HTTPError, *, body: str | None = None) -> LlmGatewayError:
        http_status = getattr(exc, "code", None)
        if body is None:
            body = self._read_http_error_body(exc)

        lowered_body = body.lower()
        if http_status in {401, 403}:
            return LlmGatewayError(
                "模型接口拒绝了当前 Key，请检查 API Key 是否正确、是否有权限访问这个模型。",
                classification="auth_error",
                http_status=http_status,
            )
        if http_status == 404:
            return LlmGatewayError(
                "没有找到当前接口或模型，请检查接口地址末尾、模型名和平台文档是否一致。",
                classification="endpoint_error",
                http_status=http_status,
            )
        if http_status == 429 or "quota" in lowered_body or "insufficient" in lowered_body or "余额" in body:
            return LlmGatewayError(
                "模型接口当前触发了额度或频率限制，请检查账户额度、计费状态或稍后再试。",
                classification="quota_error",
                http_status=http_status,
            )
        if http_status == 400:
            return LlmGatewayError(
                "模型接口返回了参数错误，请检查模型名、接口地址和请求格式是否匹配当前平台。",
                classification="request_error",
                http_status=http_status,
            )
        if http_status is not None and http_status >= 500:
            return LlmGatewayError(
                "模型服务端暂时不可用，请稍后再试。",
                classification="server_error",
                http_status=http_status,
            )

        return LlmGatewayError(
            "模型接口当前不可用，请检查接口地址、模型名和平台状态。",
            classification="unknown_error",
            http_status=http_status,
        )
