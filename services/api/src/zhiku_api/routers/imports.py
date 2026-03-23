from __future__ import annotations

from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from pydantic import BaseModel, Field

from ..repositories import LibraryRepository
from ..services import ImportService

router = APIRouter(prefix="/api/v1/imports", tags=["imports"])


class UrlImportRequest(BaseModel):
    url: str = Field(min_length=1)
    note_style: str = Field(default="structured")
    summary_focus: str = Field(default="")
    async_mode: bool = False


class FileImportRequest(BaseModel):
    file_path: str = Field(min_length=1)
    async_mode: bool = False


class FileUploadRequest(BaseModel):
    filename: str = Field(min_length=1)
    content_base64: str = Field(min_length=1)
    async_mode: bool = False


def _build_content_summary(content: dict | None) -> dict | None:
    if content is None:
        return None
    return {
        "id": content["id"],
        "title": content["title"],
        "summary": content["summary"],
        "tags": content["tags"],
        "status": content["status"],
    }


def _run_import_job(
    *,
    settings: object,
    bilibili_session_broker: object | None,
    job_id: str,
    source_kind: str,
    source_value: str,
    note_style: str = "structured",
    summary_focus: str = "",
    content_base64: str | None = None,
) -> None:
    repository = LibraryRepository(getattr(settings, "db_path"))
    import_service = ImportService(settings, bilibili_session_broker=bilibili_session_broker)
    current = repository.get_import_job(job_id)
    fallback_preview = (
        current.get("preview")
        if current and isinstance(current.get("preview"), dict)
        else import_service.build_pending_preview(
            source_value,
            source_kind=source_kind,
            note_style=note_style,
            summary_focus=summary_focus,
        )
    )
    runtime_preview = dict(fallback_preview)

    def merge_preview_patch(base_preview: dict[str, Any], patch: dict[str, Any] | None) -> dict[str, Any]:
        if not patch:
            return dict(base_preview)

        merged = dict(base_preview)
        for key, value in patch.items():
            if value is None:
                continue
            if key == "metadata" and isinstance(value, dict):
                next_metadata = (
                    dict(merged.get("metadata"))
                    if isinstance(merged.get("metadata"), dict)
                    else {}
                )
                next_metadata.update(value)
                merged["metadata"] = next_metadata
                continue
            merged[key] = value
        return merged

    def update_runtime_progress(
        step: str,
        progress: int,
        summary: str | None = None,
        preview_patch: dict[str, Any] | None = None,
    ) -> None:
        nonlocal runtime_preview
        next_preview = merge_preview_patch(runtime_preview, preview_patch)
        next_metadata = dict(next_preview.get("metadata")) if isinstance(next_preview.get("metadata"), dict) else {}
        next_preview["metadata"] = next_metadata
        next_metadata["job_runtime_step"] = step
        if summary:
            next_preview["summary"] = summary
            next_metadata["job_runtime_summary"] = summary
        runtime_preview = next_preview
        repository.update_import_job(
            job_id,
            status="running",
            progress=progress,
            step=step,
            preview=runtime_preview,
        )

    try:
        initial_step = "reading_file" if source_kind in {"file", "file_upload"} else "detecting_source"
        repository.update_import_job(
            job_id,
            status="running",
            progress=15,
            step=initial_step,
            preview=fallback_preview,
            error_code=None,
            error_message=None,
        )

        if source_kind == "url":
            preview = import_service.import_url(
                source_value,
                note_style=note_style,
                summary_focus=summary_focus,
                progress_callback=update_runtime_progress,
            )
        elif source_kind == "file":
            preview = import_service.build_file_preview(
                source_value,
                note_style=note_style,
                summary_focus=summary_focus,
            )
        elif source_kind == "file_upload":
            if content_base64 is None:
                raise ValueError("上传文件内容缺失")
            preview = import_service.build_uploaded_file_preview(
                source_value,
                content_base64,
                note_style=note_style,
                summary_focus=summary_focus,
            )
        else:
            raise ValueError(f"不支持的导入类型：{source_kind}")

        repository.update_import_job(
            job_id,
            status="running",
            progress=82,
            step="saving_content",
            preview=preview,
        )

        content = repository.upsert_content_by_source(content=preview)
        preview["content_id"] = content["id"]
        repository.update_import_job(
            job_id,
            status="completed",
            progress=100,
            step="done",
            preview=preview,
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
        failed_metadata["job_failed_reason"] = str(exc)
        failed_metadata["import_mode"] = "failed"
        failed_preview["metadata"] = failed_metadata
        failed_preview["status"] = "import_failed"
        failed_preview["summary"] = f"导入失败：{exc}"
        failed_preview["key_points"] = [
            "任务已结束，但没有成功产出内容",
            f"失败原因：{exc}",
            "建议检查链接、文件路径或设置后重试",
        ]
        from ..services.import_service import ImportErrorCode, _classify_error
        error_code = _classify_error(exc)
        repository.update_import_job(
            job_id,
            status="failed",
            progress=100,
            step="failed",
            preview=failed_preview,
            error_code=error_code.value,
            error_message=str(exc),
        )


def _handle_import(
    *,
    request: Request,
    background_tasks: BackgroundTasks,
    source_kind: str,
    source_value: str,
    async_mode: bool,
    note_style: str = "structured",
    summary_focus: str = "",
    content_base64: str | None = None,
) -> dict:
    container = request.app.state.container
    settings = container.settings
    repository = LibraryRepository(settings.db_path)
    import_service = ImportService(settings, bilibili_session_broker=container.bilibili_session_broker)

    if async_mode:
        preview = import_service.build_pending_preview(
            source_value,
            source_kind=source_kind,
            note_style=note_style,
            summary_focus=summary_focus,
        )
        job = repository.create_import_job(
            source_kind=source_kind,
            source_value=source_value,
            preview=preview,
            status="pending",
            progress=5,
            step="queued",
        )
        background_tasks.add_task(
            _run_import_job,
            settings=settings,
            bilibili_session_broker=container.bilibili_session_broker,
            job_id=job["id"],
            source_kind=source_kind,
            source_value=source_value,
            note_style=note_style,
            summary_focus=summary_focus,
            content_base64=content_base64,
        )
        return {"job": job, "content": None}

    try:
        if source_kind == "url":
            preview = import_service.import_url(
                source_value, note_style=note_style, summary_focus=summary_focus
            )
        elif source_kind == "file":
            preview = import_service.build_file_preview(
                source_value, note_style=note_style, summary_focus=summary_focus
            )
        elif source_kind == "file_upload":
            if content_base64 is None:
                raise ValueError("上传文件内容缺失")
            preview = import_service.build_uploaded_file_preview(
                source_value, content_base64, note_style=note_style, summary_focus=summary_focus
            )
        else:
            raise ValueError(f"不支持的导入类型：{source_kind}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    content = repository.upsert_content_by_source(content=preview)
    preview["content_id"] = content["id"]
    job = repository.create_import_job(
        source_kind=source_kind,
        source_value=source_value,
        preview=preview,
    )
    return {"job": job, "content": _build_content_summary(content)}


@router.post("/url")
def import_url(payload: UrlImportRequest, request: Request, background_tasks: BackgroundTasks) -> dict:
    return _handle_import(
        request=request,
        background_tasks=background_tasks,
        source_kind="url",
        source_value=payload.url,
        async_mode=payload.async_mode,
        note_style=payload.note_style,
        summary_focus=payload.summary_focus,
    )


@router.post("/file")
def import_file(payload: FileImportRequest, request: Request, background_tasks: BackgroundTasks) -> dict:
    return _handle_import(
        request=request,
        background_tasks=background_tasks,
        source_kind="file",
        source_value=payload.file_path,
        async_mode=payload.async_mode,
    )


@router.post("/file-upload")
def import_file_upload(payload: FileUploadRequest, request: Request, background_tasks: BackgroundTasks) -> dict:
    return _handle_import(
        request=request,
        background_tasks=background_tasks,
        source_kind="file_upload",
        source_value=payload.filename,
        async_mode=payload.async_mode,
        content_base64=payload.content_base64,
    )


@router.get("")
def list_import_jobs(request: Request, status: str | None = None) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    jobs = repository.list_import_jobs(status=status, limit=50)
    pending_count = sum(1 for j in jobs if j.get("status") in ("pending", "running"))
    return {"items": jobs, "total": len(jobs), "pending_count": pending_count}


@router.get("/{job_id}")
def get_import_job(job_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    job = repository.get_import_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="导入任务不存在")
    return job


@router.post("/{job_id}/retry")
def retry_import_job(job_id: str, request: Request, background_tasks: BackgroundTasks) -> dict:
    """重试失败的导入任务，创建新任务并异步执行。"""
    container = request.app.state.container
    settings = container.settings
    repository = LibraryRepository(settings.db_path)
    original = repository.get_import_job(job_id)
    if original is None:
        raise HTTPException(status_code=404, detail="导入任务不存在")
    if original.get("status") not in ("failed", "cancelled"):
        raise HTTPException(status_code=400, detail="只有失败或已取消的任务才能重试")

    source_kind = original.get("source_kind", "url")
    source_value = original.get("source_value", "")
    original_preview = original.get("preview") or {}
    original_metadata = original_preview.get("metadata") or {}
    note_style = str(original_metadata.get("note_style") or "structured")
    summary_focus = str(original_metadata.get("summary_focus") or "")

    import_service = ImportService(settings, bilibili_session_broker=container.bilibili_session_broker)
    preview = import_service.build_pending_preview(
        source_value, source_kind=source_kind, note_style=note_style, summary_focus=summary_focus
    )
    new_job = repository.create_import_job(
        source_kind=source_kind,
        source_value=source_value,
        preview=preview,
        status="pending",
        progress=5,
        step="queued",
    )
    background_tasks.add_task(
        _run_import_job,
        settings=settings,
        bilibili_session_broker=container.bilibili_session_broker,
        job_id=new_job["id"],
        source_kind=source_kind,
        source_value=source_value,
        note_style=note_style,
        summary_focus=summary_focus,
    )
    return {"job": new_job, "content": None}
