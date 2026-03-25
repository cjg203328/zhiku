from __future__ import annotations

from datetime import UTC, datetime
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from pydantic import BaseModel, Field
from uuid import uuid4

from ..config import DEFAULT_NOTE_GENERATION_MODE
from ..repositories import LibraryRepository
from ..services import ContentUpgradeService, ExportService, ImportService
from ..services.import_service import normalize_note_generation_mode

router = APIRouter(prefix="/api/v1/contents", tags=["contents"])

MAX_NOTE_VERSIONS = 12
MAX_SNAPSHOT_MARKDOWN_LENGTH = 24000
MAX_SNAPSHOT_SUMMARY_LENGTH = 2400
MAX_SNAPSHOT_TITLE_LENGTH = 240
MAX_SNAPSHOT_CAPTURE_SUMMARY_LENGTH = 600
MAX_SNAPSHOT_KEY_POINTS = 10


class ContentUpdateRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    annotations: dict | None = None


class ReparseContentRequest(BaseModel):
    note_style: str | None = None
    summary_focus: str | None = None
    note_generation_mode: str | None = None
    async_mode: bool = False


class RestoreNoteVersionRequest(BaseModel):
    version_id: str = Field(min_length=1)


class UpgradeContentsRequest(BaseModel):
    platform: str | None = None
    limit: int = Field(default=20, ge=1, le=200)
    force: bool = False
    retry_incomplete: bool = True
    dry_run: bool = False


def _trim_text(value: object, *, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def _read_metadata(payload: dict) -> dict:
    metadata = payload.get("metadata")
    return dict(metadata) if isinstance(metadata, dict) else {}


def _normalize_string_list(value: object, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        cleaned = str(item or "").strip()
        if not cleaned:
            continue
        items.append(cleaned)
        if len(items) >= limit:
            break
    return items


def _build_note_version_snapshot(payload: dict, *, source: str) -> dict | None:
    metadata = _read_metadata(payload)
    note_markdown = str(metadata.get("refined_note_markdown") or metadata.get("note_markdown") or "").strip()
    summary = str(payload.get("summary") or "").strip()
    key_points = _normalize_string_list(payload.get("key_points"), limit=MAX_SNAPSHOT_KEY_POINTS)

    if not note_markdown and not summary and not key_points:
        return None

    return {
        "id": str(uuid4()),
        "captured_at": datetime.now(UTC).isoformat(),
        "source": source,
        "title": _trim_text(payload.get("title") or "未命名内容", limit=MAX_SNAPSHOT_TITLE_LENGTH),
        "summary": _trim_text(summary, limit=MAX_SNAPSHOT_SUMMARY_LENGTH),
        "key_points": key_points,
        "note_markdown": _trim_text(note_markdown, limit=MAX_SNAPSHOT_MARKDOWN_LENGTH),
        "note_style": str(metadata.get("note_style") or "structured").strip() or "structured",
        "summary_focus": str(metadata.get("summary_focus") or "").strip(),
        "status": str(payload.get("status") or metadata.get("capture_status") or "").strip() or "ready",
        "transcript_source": str(metadata.get("transcript_source") or "").strip(),
        "capture_summary": _trim_text(metadata.get("capture_summary") or "", limit=MAX_SNAPSHOT_CAPTURE_SUMMARY_LENGTH),
    }


def _snapshot_signature(snapshot: dict | None) -> tuple[str, str, str, str, tuple[str, ...]]:
    if not snapshot:
        return ("", "", "", "", tuple())
    return (
        str(snapshot.get("note_style") or "").strip(),
        str(snapshot.get("summary_focus") or "").strip(),
        str(snapshot.get("summary") or "").strip(),
        str(snapshot.get("note_markdown") or "").strip(),
        tuple(_normalize_string_list(snapshot.get("key_points"), limit=MAX_SNAPSHOT_KEY_POINTS)),
    )


def _normalize_note_versions(value: object) -> list[dict]:
    if not isinstance(value, list):
        return []

    versions: list[dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        versions.append(
            {
                "id": str(item.get("id") or uuid4()).strip(),
                "captured_at": str(item.get("captured_at") or "").strip(),
                "source": str(item.get("source") or "reparse").strip() or "reparse",
                "title": _trim_text(item.get("title") or "未命名内容", limit=MAX_SNAPSHOT_TITLE_LENGTH),
                "summary": _trim_text(item.get("summary") or "", limit=MAX_SNAPSHOT_SUMMARY_LENGTH),
                "key_points": _normalize_string_list(item.get("key_points"), limit=MAX_SNAPSHOT_KEY_POINTS),
                "note_markdown": _trim_text(item.get("note_markdown") or "", limit=MAX_SNAPSHOT_MARKDOWN_LENGTH),
                "note_style": str(item.get("note_style") or "structured").strip() or "structured",
                "summary_focus": str(item.get("summary_focus") or "").strip(),
                "status": str(item.get("status") or "ready").strip() or "ready",
                "transcript_source": str(item.get("transcript_source") or "").strip(),
                "capture_summary": _trim_text(item.get("capture_summary") or "", limit=MAX_SNAPSHOT_CAPTURE_SUMMARY_LENGTH),
            }
        )
        if len(versions) >= MAX_NOTE_VERSIONS:
            break
    return versions


def _attach_note_version_history(existing: dict, refreshed: dict, *, source: str = "reparse") -> bool:
    existing_metadata = _read_metadata(existing)
    refreshed_metadata = _read_metadata(refreshed)
    existing_versions = _normalize_note_versions(existing_metadata.get("note_versions"))
    previous_snapshot = _build_note_version_snapshot(existing, source=source)
    current_snapshot = _build_note_version_snapshot(refreshed, source="current")

    history_added = False
    history = existing_versions

    if previous_snapshot and _snapshot_signature(previous_snapshot) != _snapshot_signature(current_snapshot):
        previous_signature = _snapshot_signature(previous_snapshot)
        deduped_history = [
            item for item in history if _snapshot_signature(item) != previous_signature
        ]
        history = [previous_snapshot, *deduped_history]
        history_added = True

    refreshed_metadata["note_versions"] = history[:MAX_NOTE_VERSIONS]
    refreshed["metadata"] = refreshed_metadata
    return history_added


def _build_job_preview_from_content(
    content: dict,
    *,
    title_prefix: str = "",
    summary_override: str | None = None,
    status: str | None = None,
    metadata_updates: dict | None = None,
) -> dict:
    metadata = _read_metadata(content)
    if metadata_updates:
        metadata.update(metadata_updates)

    title = str(content.get("title") or "未命名内容").strip() or "未命名内容"
    preview = {
        "source_type": str(content.get("source_type") or "").strip(),
        "platform": str(content.get("platform") or "").strip(),
        "source_url": content.get("source_url"),
        "source_file": content.get("source_file") or content.get("local_path"),
        "title": f"{title_prefix}{title}",
        "content_text": str(content.get("content_text") or ""),
        "summary": summary_override if summary_override is not None else str(content.get("summary") or "").strip(),
        "key_points": _normalize_string_list(content.get("key_points"), limit=MAX_SNAPSHOT_KEY_POINTS),
        "tags": _normalize_string_list(content.get("tags"), limit=24),
        "metadata": metadata,
        "content_id": str(content.get("id") or "").strip() or None,
        "status": status or str(content.get("status") or "").strip() or "ready",
    }
    return preview


def _build_reparse_pending_preview(
    content: dict,
    *,
    note_style: str,
    summary_focus: str,
    note_generation_mode: str,
) -> dict:
    preview = _build_job_preview_from_content(
        content,
        title_prefix="正在重新解析：",
        summary_override="系统正在后台重新抓取正文、截图和笔记，完成后会自动刷新当前内容。",
        status="import_pending",
        metadata_updates={
            "import_mode": "reparse_pending",
            "job_mode": "reparse",
            "note_style": str(note_style).strip() or "structured",
            "summary_focus": str(summary_focus).strip(),
            "note_generation_mode": normalize_note_generation_mode(note_generation_mode),
        },
    )
    preview["content_text"] = ""
    preview["key_points"] = [
        "已接收重新解析任务",
        "系统正在恢复正文并重建笔记",
        "完成后会直接覆盖当前内容并保留上一版历史",
    ]
    if not preview["tags"]:
        preview["tags"] = ["重解析中"]
    return preview


def _build_reparse_success_message(*, history_added: bool) -> str:
    return "内容已重新解析并覆盖更新，上一版已保存到版本历史" if history_added else "内容已重新解析并覆盖更新"


def _run_reparse_job(
    *,
    settings: object,
    bilibili_session_broker: object | None,
    job_id: str,
    content_id: str,
    source_url: str,
    source_file: str,
    note_style: str,
    summary_focus: str,
    note_generation_mode: str,
) -> None:
    repository = LibraryRepository(getattr(settings, "db_path"))
    import_service = ImportService(settings, bilibili_session_broker=bilibili_session_broker)
    content = repository.get_content(content_id)
    current_job = repository.get_import_job(job_id)

    fallback_preview = (
        current_job.get("preview")
        if current_job and isinstance(current_job.get("preview"), dict)
        else _build_reparse_pending_preview(
            content or {"id": content_id, "title": "当前内容", "tags": [], "metadata": {}},
            note_style=note_style,
            summary_focus=summary_focus,
            note_generation_mode=note_generation_mode,
        )
    )

    try:
        if content is None:
            raise ValueError("待重解析的内容不存在")
        if not source_url and not source_file:
            raise ValueError("这条内容没有可用于重解析的原始来源")

        initial_step = "reading_file" if source_file else "detecting_source"
        repository.update_import_job(
            job_id,
            status="running",
            progress=12,
            step=initial_step,
            preview=fallback_preview,
            error_code=None,
            error_message=None,
        )
        repository.update_import_job(
            job_id,
            status="running",
            progress=46,
            step="parsing_content",
            preview=fallback_preview,
        )

        if source_url:
            preview = import_service.import_url(
                source_url,
                note_style=note_style,
                summary_focus=summary_focus,
                note_generation_mode=note_generation_mode,
            )
        else:
            preview = import_service.build_file_preview(
                source_file,
                note_style=note_style,
                summary_focus=summary_focus,
                note_generation_mode=note_generation_mode,
            )

        writing_preview = _build_reparse_pending_preview(
            content,
            note_style=note_style,
            summary_focus=summary_focus,
            note_generation_mode=note_generation_mode,
        )
        writing_preview["summary"] = "正文已重新取回，正在保存版本历史并刷新当前内容。"
        writing_preview["key_points"] = [
            "正文提取已完成",
            "正在保存上一版内容到版本历史",
            "正在覆盖当前内容并刷新详情页",
        ]
        repository.update_import_job(
            job_id,
            status="running",
            progress=82,
            step="saving_content",
            preview=writing_preview,
        )

        history_added = _attach_note_version_history(content, preview, source="reparse")
        refreshed = repository.replace_content(content_id, content=preview)
        if refreshed is None:
            raise ValueError("内容不存在")

        success_message = _build_reparse_success_message(history_added=history_added)
        completed_preview = _build_job_preview_from_content(
            refreshed,
            metadata_updates={
                "job_mode": "reparse",
                "job_message": success_message,
            },
        )
        repository.update_import_job(
            job_id,
            status="completed",
            progress=100,
            step="done",
            preview=completed_preview,
            error_code=None,
            error_message=None,
        )
    except Exception as exc:
        failed_preview = dict(fallback_preview)
        failed_metadata = (
            dict(failed_preview.get("metadata"))
            if isinstance(failed_preview.get("metadata"), dict)
            else {}
        )
        failed_metadata["job_mode"] = "reparse"
        failed_metadata["job_failed_reason"] = str(exc)
        failed_preview["metadata"] = failed_metadata
        failed_preview["status"] = "import_failed"
        failed_preview["summary"] = f"重新解析失败：{exc}"
        failed_preview["key_points"] = [
            "任务已结束，但没有成功完成重解析",
            f"失败原因：{exc}",
            "建议稍后重试，或先检查当前模型、Cookie 与本地转写环境",
        ]
        repository.update_import_job(
            job_id,
            status="failed",
            progress=100,
            step="failed",
            preview=failed_preview,
            error_code="reparse_failed",
            error_message=str(exc),
        )


def _restore_note_version(content: dict, *, version_id: str) -> tuple[dict, dict]:
    metadata = _read_metadata(content)
    versions = _normalize_note_versions(metadata.get("note_versions"))
    target_version = next((item for item in versions if str(item.get("id") or "").strip() == version_id.strip()), None)
    if target_version is None:
        raise HTTPException(status_code=404, detail="指定的笔记版本不存在")

    restored = dict(content)
    restored_metadata = _read_metadata(content)
    restored["summary"] = str(target_version.get("summary") or "").strip()
    restored["key_points"] = _normalize_string_list(target_version.get("key_points"), limit=MAX_SNAPSHOT_KEY_POINTS)

    restored_metadata["note_markdown"] = str(target_version.get("note_markdown") or "").strip()
    restored_metadata["refined_note_markdown"] = str(target_version.get("note_markdown") or "").strip()
    restored_metadata["note_style"] = str(target_version.get("note_style") or "structured").strip() or "structured"
    restored_metadata["summary_focus"] = str(target_version.get("summary_focus") or "").strip()
    restored_metadata["restored_note_version_id"] = str(target_version.get("id") or "").strip()
    restored_metadata["restored_note_version_at"] = datetime.now(UTC).isoformat()

    current_snapshot = _build_note_version_snapshot(content, source="restore")
    target_signature = _snapshot_signature(target_version)
    current_signature = _snapshot_signature(current_snapshot)

    remaining_versions = [
        item for item in versions if str(item.get("id") or "").strip() != str(target_version.get("id") or "").strip()
    ]
    deduped_versions = [item for item in remaining_versions if _snapshot_signature(item) != current_signature]
    if current_snapshot and current_signature != target_signature:
        deduped_versions = [current_snapshot, *deduped_versions]
    restored_metadata["note_versions"] = deduped_versions[:MAX_NOTE_VERSIONS]

    restored["metadata"] = restored_metadata
    return restored, target_version


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
def reparse_content(content_id: str, request: Request, background_tasks: BackgroundTasks, payload: ReparseContentRequest | None = None) -> dict:
    container = request.app.state.container
    settings = container.settings
    repository = LibraryRepository(settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    source_url = (content.get("source_url") or "").strip()
    source_file = (content.get("source_file") or content.get("local_path") or "").strip()
    metadata = content.get("metadata") if isinstance(content.get("metadata"), dict) else {}
    note_style = (payload.note_style if payload and payload.note_style is not None else metadata.get("note_style") or "structured")
    summary_focus = (payload.summary_focus if payload and payload.summary_focus is not None else metadata.get("summary_focus") or "")
    note_generation_mode = normalize_note_generation_mode(
        payload.note_generation_mode if payload and payload.note_generation_mode is not None else metadata.get("note_generation_mode") or DEFAULT_NOTE_GENERATION_MODE
    )

    if payload and payload.async_mode:
        pending_preview = _build_reparse_pending_preview(
            content,
            note_style=str(note_style),
            summary_focus=str(summary_focus),
            note_generation_mode=note_generation_mode,
        )
        source_value = source_file or source_url or content_id
        job = repository.create_import_job(
            source_kind="file" if source_file else "url",
            source_value=source_value,
            preview=pending_preview,
            status="pending",
            progress=5,
            step="queued",
        )
        background_tasks.add_task(
            _run_reparse_job,
            settings=settings,
            bilibili_session_broker=container.bilibili_session_broker,
            job_id=job["id"],
            content_id=content_id,
            source_url=source_url,
            source_file=source_file,
            note_style=str(note_style),
            summary_focus=str(summary_focus),
            note_generation_mode=note_generation_mode,
        )
        return {
            "ok": True,
            "job": job,
            "content": None,
            "message": "已开始后台重新解析，完成后会自动刷新当前内容",
        }

    import_service = ImportService(settings, bilibili_session_broker=container.bilibili_session_broker)
    if source_url:
        preview = import_service.import_url(
            source_url,
            note_style=str(note_style),
            summary_focus=str(summary_focus),
            note_generation_mode=note_generation_mode,
        )
    elif source_file:
        try:
            preview = import_service.build_file_preview(
                source_file,
                note_style=str(note_style),
                summary_focus=str(summary_focus),
                note_generation_mode=note_generation_mode,
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"原始文件无法重新解析：{exc}") from exc
    else:
        raise HTTPException(status_code=400, detail="这条内容没有可用于重解析的原始来源")

    history_added = _attach_note_version_history(content, preview, source="reparse")
    refreshed = repository.replace_content(content_id, content=preview)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    return {
        "ok": True,
        "content": refreshed,
        "job": None,
        "message": _build_reparse_success_message(history_added=history_added),
    }


@router.post("/{content_id}/restore-note-version")
def restore_note_version(content_id: str, payload: RestoreNoteVersionRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    content = repository.get_content(content_id)
    if content is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    restored_content, restored_version = _restore_note_version(content, version_id=payload.version_id)
    refreshed = repository.replace_content(content_id, content=restored_content)
    if refreshed is None:
        raise HTTPException(status_code=404, detail="内容不存在")

    restored_label = str(restored_version.get("summary_focus") or restored_version.get("title") or "所选版本").strip()
    return {
        "ok": True,
        "content": refreshed,
        "message": f"已将“{restored_label}”恢复为当前版本，恢复前的版本也已保留到历史里",
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
