from __future__ import annotations

import json

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from fastapi.responses import StreamingResponse

from fastapi import HTTPException

from ..repositories import LibraryRepository
from ..services import ChatService
from ..services.llm_gateway import LlmGatewayError

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])


class ChatRequest(BaseModel):
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=10)
    content_id: str | None = None
    chunk_id: str | None = None
    session_id: str | None = None


class SaveNoteCitation(BaseModel):
    content_id: str
    chunk_id: str | None = None
    chunk_index: int | None = None
    heading: str | None = None
    title: str
    snippet: str
    score: float
    platform: str | None = None
    source_url: str | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    seek_url: str | None = None


class SaveNoteRequest(BaseModel):
    question: str = Field(min_length=1)
    answer: str = Field(min_length=1)
    citations: list[SaveNoteCitation] = Field(default_factory=list)
    title: str | None = None
    content_id: str | None = None
    chunk_id: str | None = None


class ChatSessionTurnRequest(BaseModel):
    question: str = Field(min_length=1)
    answer: str = Field(min_length=1)
    citations: list[SaveNoteCitation] = Field(default_factory=list)
    session_id: str | None = None


@router.post("")
def chat_once(payload: ChatRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    session = repository.get_chat_session(payload.session_id.strip()) if payload.session_id else None
    try:
        result = ChatService(request.app.state.container.settings).answer(
            payload.query,
            repository=repository,
            limit=payload.limit,
            content_id=payload.content_id,
            chunk_id=payload.chunk_id,
            session_messages=(session or {}).get("messages") if session else None,
        )
    except LlmGatewayError as exc:
        raise HTTPException(status_code=503, detail={"error": True, "error_code": exc.classification or "llm_unavailable", "message": str(exc)}) from exc
    return {
        "query": payload.query,
        **result,
    }


@router.post("/stream")
def stream_chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    session = repository.get_chat_session(payload.session_id.strip()) if payload.session_id else None
    service = ChatService(request.app.state.container.settings)
    try:
        result = service.answer(
            payload.query,
            repository=repository,
            limit=payload.limit,
            content_id=payload.content_id,
            chunk_id=payload.chunk_id,
            session_messages=(session or {}).get("messages") if session else None,
        )
    except LlmGatewayError as exc:
        error_payload = json.dumps({"error": True, "error_code": exc.classification or "llm_unavailable", "message": str(exc)}, ensure_ascii=False)
        def error_stream():
            yield f"event: error\ndata: {error_payload}\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")
    answer_chunks = service.chunk_answer(result["answer"])
    quality = result.get("quality") or {}
    low_recall = bool(quality.get("low_recall") or quality.get("level") in ("low", "empty"))

    def event_stream():
        yield f"event: meta\ndata: {json.dumps({'query': payload.query, 'mode': result['mode'], 'content_id': payload.content_id, 'chunk_id': payload.chunk_id, 'session_id': payload.session_id, 'retrieval': result.get('retrieval', {}), 'quality': quality}, ensure_ascii=False)}\n\n"
        for chunk in answer_chunks:
            yield f"event: message\ndata: {json.dumps({'chunk': chunk}, ensure_ascii=False)}\n\n"
        yield f"event: done\ndata: {json.dumps({'citations': result['citations'], 'follow_ups': result.get('follow_ups', []), 'retrieval': result.get('retrieval', {}), 'quality': quality, 'low_recall': low_recall}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/sessions")
def list_chat_sessions(request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    return repository.list_chat_sessions()


@router.get("/sessions/{session_id}")
def get_chat_session(session_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    session = repository.get_chat_session(session_id)
    if session is None:
        return {"id": session_id, "messages": [], "retention_days": 7}
    return session


@router.delete("/sessions/{session_id}")
def delete_chat_session(session_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.delete_chat_session(session_id)
    return {"deleted": deleted, "id": session_id}


@router.post("/sessions/turn")
def save_chat_turn(payload: ChatSessionTurnRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    session = repository.save_chat_turn(
        question=payload.question.strip(),
        answer=payload.answer.strip(),
        citations=[item.model_dump() for item in payload.citations],
        session_id=payload.session_id.strip() if payload.session_id else None,
    )
    return {
        "ok": True,
        "session": session,
        "message": "这轮问答已加入会话记录",
    }


@router.post("/save-note")
def save_chat_note(payload: SaveNoteRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    answer_text = payload.answer.strip()
    question = payload.question.strip()
    title = (payload.title or "").strip() or f"问答笔记：{question[:24]}"

    paragraphs = [item.strip() for item in answer_text.splitlines() if item.strip()]
    key_points: list[str] = []
    for item in paragraphs:
        normalized = item.lstrip("-•1234567890.、）) ").strip()
        if normalized and normalized not in key_points:
            key_points.append(normalized)
        if len(key_points) >= 5:
            break

    citations_payload = [citation.model_dump() for citation in payload.citations]
    evidence_digest = _build_evidence_digest(citations_payload)
    evidence_digest_lines = [item["line"] for item in evidence_digest]
    evidence_summary = _build_evidence_summary(evidence_digest)
    if evidence_digest_lines:
        for item in evidence_digest_lines[:2]:
            if item not in key_points:
                key_points.append(item)
            if len(key_points) >= 6:
                break

    note_markdown_lines = [
        f"# {title}",
        "",
        "## 提问",
        "",
        question,
        "",
        "## 回答",
        "",
        answer_text,
    ]
    if evidence_digest:
        note_markdown_lines.extend(["", "## 证据摘要", ""])
        note_markdown_lines.extend([f"- {item['line']}" for item in evidence_digest[:4]])
        if evidence_summary:
            note_markdown_lines.extend(["", "## 回看建议", "", evidence_summary])
    if citations_payload:
        note_markdown_lines.extend(["", "## 引用来源", ""])
        note_markdown_lines.extend(
            [
                f"- 《{item['title']}》{_format_citation_range(item)}：{item['snippet']}"
                for item in citations_payload[:8]
            ]
        )

    content = repository.create_content(
        content={
            "source_type": "chat_note",
            "platform": "assistant",
            "source_url": None,
            "source_file": None,
            "title": title,
            "author": "知库问答",
            "content_text": _build_note_content_text(answer_text, evidence_digest_lines, evidence_summary),
            "summary": answer_text[:160] + ("..." if len(answer_text) > 160 else ""),
            "key_points": key_points or [answer_text[:80]],
            "quotes": [],
            "category": "问答沉淀",
            "content_type": "note",
            "use_case": "复盘",
            "tags": _build_note_tags(citations_payload),
            "metadata": {
                "question": question,
                "citations": citations_payload,
                "evidence_digest": evidence_digest,
                "evidence_summary": evidence_summary,
                "source_content_id": payload.content_id,
                "source_chunk_id": payload.chunk_id,
                "note_markdown": "\n".join(note_markdown_lines),
                "saved_from": "chat",
            },
            "local_path": None,
            "status": "ready",
        }
    )
    return {
        "ok": True,
        "content": content,
        "message": "这次问答已保存为知识卡片",
    }


def _format_citation_range(item: dict) -> str:
    start_ms = item.get("start_ms")
    end_ms = item.get("end_ms")
    start_label = _format_ms(start_ms)
    end_label = _format_ms(end_ms)
    if start_label and end_label:
        return f"（{start_label} - {end_label}）"
    if start_label:
        return f"（{start_label}）"
    return ""


def _format_ms(value: int | None) -> str:
    if value is None:
        return ""
    total_seconds = max(0, int(value) // 1000)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


def _build_evidence_digest(citations: list[dict]) -> list[dict]:
    ranked = sorted(
        citations,
        key=lambda item: (
            0 if item.get("start_ms") is not None or item.get("end_ms") is not None else 1,
            -float(item.get("score") or 0),
        ),
    )
    picked: list[dict] = []
    seen: set[str] = set()
    for item in ranked:
        signature = (
            str(item.get("chunk_id") or "").strip()
            or f"{item.get('content_id')}:{item.get('chunk_index')}:{item.get('start_ms')}:{item.get('end_ms')}"
        )
        if signature in seen:
            continue
        seen.add(signature)
        title = str(item.get("title") or "来源内容").strip()
        heading = str(item.get("heading") or "").strip()
        time_label = _format_citation_range(item).strip("（）")
        snippet = _clean_citation_snippet(str(item.get("snippet") or "").strip())
        anchor = heading or time_label or "命中片段"
        line = f"《{title}》 {anchor}"
        if snippet:
            line = f"{line}：{snippet}"
        picked.append(
            {
                "title": title,
                "anchor": anchor,
                "time_label": time_label,
                "heading": heading,
                "snippet": snippet,
                "line": line.strip(),
            }
        )
        if len(picked) >= 4:
            break
    return picked


def _build_evidence_summary(evidence_digest: list[dict]) -> str:
    if not evidence_digest:
        return ""
    first = evidence_digest[0]
    anchor = str(first.get("anchor") or "命中片段").strip()
    title = str(first.get("title") or "这条内容").strip()
    if len(evidence_digest) == 1:
        return f"优先回看《{title}》的 {anchor}，先确认这轮回答最关键的依据。"
    second = evidence_digest[1]
    second_anchor = str(second.get("anchor") or "另一个命中片段").strip()
    return f"建议先看《{title}》的 {anchor}，再补看 {second_anchor}，这样更容易判断结论和细节是不是都站得住。"


def _build_note_content_text(answer_text: str, evidence_digest_lines: list[str], evidence_summary: str) -> str:
    sections = [answer_text.strip()]
    if evidence_digest_lines:
        sections.extend(
            [
                "",
                "证据摘要：",
                *[f"- {item}" for item in evidence_digest_lines[:4]],
            ]
        )
    if evidence_summary:
        sections.extend(["", f"回看建议：{evidence_summary}"])
    return "\n".join(item for item in sections if item is not None).strip()


def _build_note_tags(citations: list[dict]) -> list[str]:
    tags = ["问答", "AI整理", "知识卡片"]
    if citations:
        tags.append("带证据")
    platforms: list[str] = []
    for item in citations[:4]:
        platform = str(item.get("platform") or "").strip()
        if platform and platform not in platforms:
            platforms.append(platform)
    tags.extend(platforms[:2])
    return tags


def _clean_citation_snippet(value: str) -> str:
    cleaned = " ".join(value.replace("\n", " ").split()).strip()
    if len(cleaned) <= 88:
        return cleaned
    return cleaned[:88].rstrip() + "..."
