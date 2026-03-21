from __future__ import annotations

from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


class BackupService:
    def __init__(self, knowledge_base_dir: Path) -> None:
        self.knowledge_base_dir = knowledge_base_dir
        self.backup_dir = knowledge_base_dir / "backups"

    def create_backup(self) -> Path:
        self.backup_dir.mkdir(parents=True, exist_ok=True)
        archive_name = f"zhiku-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
        archive_path = self.backup_dir / archive_name

        with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
            self._add_tree(archive, self.knowledge_base_dir / "db")
            self._add_tree(archive, self.knowledge_base_dir / "index")
            self._add_tree(archive, self.knowledge_base_dir / "contents")

        return archive_path

    def _add_tree(self, archive: ZipFile, root: Path) -> None:
        if not root.exists():
            return
        for path in root.rglob("*"):
            if path.is_file():
                archive.write(path, arcname=path.relative_to(self.knowledge_base_dir))
