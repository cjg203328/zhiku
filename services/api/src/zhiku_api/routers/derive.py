from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import PlainTextResponse

from ..repositories import LibraryRepository
from ..services.derive_service import DeriveService

router = APIRouter(prefix="/api/v1/derive", tags=["derive"])


@router.post("/{content_id}/mindmap")
def generate_mindmap(content_id: str, request: Request) -> dict:
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    existing = [item for item in repository.list_derived_items(content_id) if item["kind"] == "mindmap"]
    if existing:
        return {"ok": True, "item": existing[0], "cached": True}

    chunks = repository.get_chunks_by_content_id(content_id, limit=12)

    service = DeriveService(settings)
    data = service.generate_mindmap(content, chunks)
    title = f"{content.get('title', '思维导图')} — 思维导图"
    item = repository.create_derived_item(content_id=content_id, kind="mindmap", title=title, data=data)
    return {"ok": True, "item": item, "cached": False}


@router.post("/{content_id}/quiz")
def generate_quiz(content_id: str, request: Request) -> dict:
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    existing = [item for item in repository.list_derived_items(content_id) if item["kind"] == "quiz"]
    if existing:
        return {"ok": True, "item": existing[0], "cached": True}

    chunks = repository.get_chunks_by_content_id(content_id, limit=12)

    service = DeriveService(settings)
    questions = service.generate_quiz(content, chunks)
    title = f"{content.get('title', '随堂测验')} — 测验"
    item = repository.create_derived_item(content_id=content_id, kind="quiz", title=title, data={"questions": questions})
    return {"ok": True, "item": item, "cached": False}


@router.get("/items/{item_id}/export-markdown")
def export_mindmap_markdown(item_id: str, request: Request) -> PlainTextResponse:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    items = []
    # Search across all derived items by fetching via a workaround — we need a get_derived_item method
    # For now iterate all items for this item_id by fetching from DB directly
    import sqlite3
    db_path = str(request.app.state.container.settings.db_path)
    conn = sqlite3.connect(db_path)
    row = conn.execute("SELECT id, content_id, kind, title, data_json FROM derived_items WHERE id = ?", (item_id,)).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="派生项不存在")
    kind = row[2]
    title = row[3]
    data = json.loads(row[4] or "{}")
    if kind == "mindmap":
        md = _mindmap_to_markdown(title, data)
    elif kind == "quiz":
        md = _quiz_to_anki(title, data)
    else:
        raise HTTPException(status_code=400, detail=f"不支持导出类型 {kind}")
    return PlainTextResponse(content=md, media_type="text/plain; charset=utf-8")


def _mindmap_to_markdown(title: str, data: dict) -> str:
    lines = [f"# {title}", ""]
    def render_node(node: dict, depth: int) -> None:
        label = node.get("label") or node.get("title") or ""
        prefix = "  " * (depth - 1) + "- " if depth > 0 else "## "
        lines.append(f"{prefix}{label}")
        for child in node.get("children") or []:
            render_node(child, depth + 1)
    root = data.get("root") or data
    if isinstance(root, dict):
        render_node(root, 0)
    elif isinstance(data.get("nodes"), list):
        for node in data["nodes"]:
            render_node(node, 1)
    return "\n".join(lines)


def _quiz_to_anki(title: str, data: dict) -> str:
    """Export quiz as Anki-compatible tab-separated Q\tA format."""
    lines = [f"# {title} (Anki 导入格式)", "# 格式：问题\t答案", ""]
    questions = data.get("questions") or []
    for q in questions:
        question = str(q.get("question") or "").replace("\t", " ").replace("\n", " ")
        answer = str(q.get("answer") or "").replace("\t", " ").replace("\n", " ")
        if question:
            lines.append(f"{question}\t{answer}")
    return "\n".join(lines)


@router.get("/{content_id}")
def list_derived_items(content_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    items = repository.list_derived_items(content_id)
    return {"items": items, "total": len(items)}


@router.delete("/items/{item_id}")
def delete_derived_item(item_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.delete_derived_item(item_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="派生项不存在")
    return {"deleted": True, "id": item_id}
