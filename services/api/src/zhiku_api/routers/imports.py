from __future__ import annotations

from datetime import UTC, datetime
from threading import Event, Lock, Thread
from time import monotonic
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


def _format_elapsed_runtime(seconds: int) -> str:
    total_seconds = max(1, int(seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours}小时{minutes}分"
    if minutes > 0:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"


def _extract_preview_duration_seconds(preview: dict[str, Any]) -> int | None:
    metadata = preview.get("metadata") if isinstance(preview.get("metadata"), dict) else {}
    raw_duration = metadata.get("duration")
    try:
        duration = int(raw_duration)
    except (TypeError, ValueError):
        return None
    return duration if duration > 0 else None


def _build_transcribing_heartbeat_summary(duration_seconds: int | None, elapsed_seconds: int) -> str:
    elapsed_label = _format_elapsed_runtime(elapsed_seconds)
    if not duration_seconds or duration_seconds <= 0:
        return f"正在执行本地音频转写，已持续 {elapsed_label}，任务仍在运行。"

    duration_label = _format_elapsed_runtime(duration_seconds)
    if duration_seconds <= 3 * 60:
        return f"正在执行本地音频转写（已持续 {elapsed_label}，视频时长 {duration_label}，通常需要 1-3 分钟）。"
    if duration_seconds <= 8 * 60:
        return f"正在执行本地音频转写（已持续 {elapsed_label}，视频时长 {duration_label}，通常需要几分钟）。"
    return f"正在执行本地音频转写（已持续 {elapsed_label}，视频时长 {duration_label}，长视频可能需要更久）。"


def _resolve_transcribing_heartbeat_progress(duration_seconds: int | None, elapsed_seconds: int) -> int:
    baseline = 72
    ceiling = 79
    if duration_seconds is None or duration_seconds <= 0:
        expected_seconds = 180
    elif duration_seconds <= 3 * 60:
        expected_seconds = 90
    elif duration_seconds <= 8 * 60:
        expected_seconds = 180
    else:
        expected_seconds = min(max(int(duration_seconds * 0.55), 240), 480)

    ratio = min(1.0, max(0.0, elapsed_seconds / max(expected_seconds, 1)))
    return min(ceiling, baseline + int(ratio * (ceiling - baseline)))


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
    runtime_preview_lock = Lock()
    transcribing_heartbeat_thread: Thread | None = None
    transcribing_heartbeat_stop: Event | None = None
    transcribing_heartbeat_started_at: str | None = None

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

    def stop_transcribing_heartbeat() -> None:
        nonlocal transcribing_heartbeat_thread, transcribing_heartbeat_stop
        stop_event = transcribing_heartbeat_stop
        transcribing_heartbeat_stop = None
        transcribing_heartbeat_thread = None
        if stop_event is not None:
            stop_event.set()

    def start_transcribing_heartbeat(progress_seed: int) -> None:
        nonlocal transcribing_heartbeat_thread, transcribing_heartbeat_stop, transcribing_heartbeat_started_at, runtime_preview
        stop_transcribing_heartbeat()
        stop_event = Event()
        started_at_iso = datetime.now(UTC).isoformat()
        started_at_monotonic = monotonic()
        transcribing_heartbeat_stop = stop_event
        transcribing_heartbeat_started_at = started_at_iso

        def heartbeat_loop() -> None:
            nonlocal runtime_preview
            heartbeat_count = 0
            while not stop_event.wait(8.0):
                heartbeat_count += 1
                elapsed_seconds = max(1, int(monotonic() - started_at_monotonic))
                with runtime_preview_lock:
                    duration_seconds = _extract_preview_duration_seconds(runtime_preview)
                    heartbeat_summary = _build_transcribing_heartbeat_summary(duration_seconds, elapsed_seconds)
                    heartbeat_progress = max(
                        progress_seed,
                        _resolve_transcribing_heartbeat_progress(duration_seconds, elapsed_seconds),
                    )
                    next_preview = merge_preview_patch(
                        runtime_preview,
                        {
                            "summary": heartbeat_summary,
                            "metadata": {
                                "job_runtime_step": "transcribing_audio",
                                "job_runtime_summary": heartbeat_summary,
                                "job_runtime_started_at": started_at_iso,
                                "job_runtime_last_heartbeat_at": datetime.now(UTC).isoformat(),
                                "job_runtime_heartbeat_count": heartbeat_count,
                                "job_runtime_elapsed_seconds": elapsed_seconds,
                                "job_runtime_activity_label": f"本地转写仍在继续，已持续 {_format_elapsed_runtime(elapsed_seconds)}",
                                "job_runtime_alive": True,
                            },
                        },
                    )
                    runtime_preview = next_preview

                repository.update_import_job(
                    job_id,
                    status="running",
                    progress=heartbeat_progress,
                    step="transcribing_audio",
                    preview=next_preview,
                )

        thread = Thread(
            target=heartbeat_loop,
            name=f"import-transcribing-heartbeat-{job_id}",
            daemon=True,
        )
        transcribing_heartbeat_thread = thread
        thread.start()

    def update_runtime_progress(
        step: str,
        progress: int,
        summary: str | None = None,
        preview_patch: dict[str, Any] | None = None,
    ) -> None:
        nonlocal runtime_preview
        if step != "transcribing_audio":
            stop_transcribing_heartbeat()

        with runtime_preview_lock:
            next_preview = merge_preview_patch(runtime_preview, preview_patch)
            next_metadata = dict(next_preview.get("metadata")) if isinstance(next_preview.get("metadata"), dict) else {}
            next_preview["metadata"] = next_metadata
            next_metadata["job_runtime_step"] = step
            next_metadata["job_runtime_last_heartbeat_at"] = datetime.now(UTC).isoformat()
            if step == "transcribing_audio":
                next_metadata["job_runtime_started_at"] = (
                    transcribing_heartbeat_started_at or next_metadata.get("job_runtime_started_at") or datetime.now(UTC).isoformat()
                )
                next_metadata["job_runtime_alive"] = True
            else:
                next_metadata["job_runtime_alive"] = False
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
        if step == "transcribing_audio":
            start_transcribing_heartbeat(progress)

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

        stop_transcribing_heartbeat()
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
        stop_transcribing_heartbeat()
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
