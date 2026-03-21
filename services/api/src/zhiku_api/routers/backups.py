from datetime import datetime, UTC

from fastapi import APIRouter, Request

from ..services import BackupService

router = APIRouter(prefix="/api/v1/backups", tags=["backups"])


@router.get("")
def list_backups() -> dict:
    return {"items": []}


@router.post("")
def create_backup(request: Request) -> dict:
    knowledge_base_dir = request.app.state.container.settings.knowledge_base_dir
    archive_path = BackupService(knowledge_base_dir).create_backup()
    return {
        "status": "completed",
        "knowledge_base_dir": str(knowledge_base_dir),
        "archive_path": str(archive_path),
        "created_at": datetime.now(UTC).isoformat(),
    }
