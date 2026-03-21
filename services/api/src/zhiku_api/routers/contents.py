from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..repositories import LibraryRepository
from ..services import ContentUpgradeService, ExportService, ImportService

router = APIRouter(prefix="/api/v1/contents", tags=["contents"])


class ContentUpdateRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    annotations: dict | None = None


class ReparseContentRequest(BaseModel):
    note_style: str | None = None
    summary_focus: str | None = None


class UpgradeContentsRequest(BaseModel):
    platform: str | None = None
    limit: int = Field(default=20, ge=1, le=200)
    force: bool = False
    retry_incomplete: bool = True
    dry_run: bool = False


@router.get("")
def list_contents(
    request: Request,
    q: str | None = Query(default=None),
    collection_id: str | None = Query(default=None),
) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    return repository.list_contents(query=q, collection_id=collection_id)


@router.post("/maintenance/upgrade")
def upgrade_contents(payload: UpgradeContentsRequest, request: Request) -> dict:
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    service = ContentUpgradeService(settings)
    return service.upgrade_contents(
        repository,
        platform=payload.platform,
        limit=payload.limit,
        force=payload.force,
        retry_incomplete=payload.retry_incomplete,
        dry_run=payload.dry_run,
    )


@router.get("/{content_id}")
def get_content(content_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")
    return content


@router.patch("/{content_id}")
def update_content(content_id: str, payload: ContentUpdateRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    content = repository.update_content(
        content_id,
        title=payload.title,
        summary=payload.summary,
        category=payload.category,
        tags=payload.tags,
        annotations=payload.annotations,
    )
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")
    return content


@router.delete("/{content_id}")
def delete_content(content_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.soft_delete_content(content_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="内容不存在")
    return {"deleted": True, "id": content_id}


@router.get("/trash/list")
def list_deleted_contents(request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    return repository.list_deleted_contents()


@router.post("/trash/empty")
def empty_trash(request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.empty_trash()
    message = "回收站已清空" if deleted > 0 else "回收站本来就是空的"
    return {"ok": True, "deleted": deleted, "message": message}


@router.delete("/{content_id}/permanent")
def permanent_delete_content(content_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.permanent_delete_content(content_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="内容不存在或不在回收站中")
    return {"deleted": True, "id": content_id}


@router.post("/{content_id}/restore")
def restore_content(content_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    restored = repository.restore_content(content_id)
    if not restored:
        raise HTTPException(status_code=404, detail="内容不存在或未在回收站中")
    return {"restored": True, "id": content_id}


@router.post("/{content_id}/export-markdown")
def export_markdown(
    content_id: str,
    request: Request,
    include_annotations: bool = Query(default=False),
) -> dict:
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    export_service = ExportService(settings.knowledge_base_dir / "exports")
    output_path = export_service.export_content_markdown(content, include_annotations=include_annotations)
    return {
        "ok": True,
        "content_id": content_id,
        "path": str(output_path),
    }


@router.post("/{content_id}/reparse")
def reparse_content(content_id: str, request: Request, payload: ReparseContentRequest | None = None) -> dict:
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    source_url = (content.get("source_url") or "").strip()
    source_file = (content.get("source_file") or content.get("local_path") or "").strip()
    metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
    note_style = (payload.note_style if payload and payload.note_style is not None else metadata.get("note_style") or "structured")
    summary_focus = (payload.summary_focus if payload and payload.summary_focus is not None else metadata.get("summary_focus") or "")

    import_service = ImportService(settings)
    if source_url:
        preview = import_service.import_url(
            source_url,
            note_style=str(note_style),
            summary_focus=str(summary_focus),
        )
    elif source_file:
        try:
            preview = import_service.build_file_preview(source_file)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"原始文件无法重新解析：{exc}") from exc
    else:
        raise HTTPException(status_code=400, detail="这条内容没有可用于重解析的原始来源")

    refreshed = repository.replace_content(content_id, content=preview)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    return {
        "ok": True,
        "content": refreshed,
        "message": "内容已重新解析并覆盖更新",
    }


@router.post("/{content_id}/reindex")
def reindex_content(content_id: str, request: Request) -> dict:
    """重建单条内容的 FTS 片段索引。"""
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    connection = repository._connect()
    try:
        # 删除该内容相关的 FTS 片段记录，再重新插入
        chunk_rows = connection.execute(
            "SELECT rowid, chunk_text, summary FROM content_chunks WHERE content_id = ?",
            (content_id,),
        ).fetchall()
        if not chunk_rows:
            return {"ok": True, "chunks_count": 0, "message": "该内容暂无片段，无需重建。"}

        rowids = [r[0] for r in chunk_rows]
        for rowid in rowids:
            connection.execute(
                "DELETE FROM content_chunks_fts WHERE rowid = ?", (rowid,)
            )
        connection.executemany(
            "INSERT INTO content_chunks_fts(rowid, chunk_text, summary) VALUES (?, ?, ?)",
            [(r[0], r[1] or "", r[2] or "") for r in chunk_rows],
        )
        connection.commit()
    finally:
        connection.close()

    return {
        "ok": True,
        "chunks_count": len(chunk_rows),
        "message": f"片段索引已重建，共 {len(chunk_rows)} 条。",
    }
