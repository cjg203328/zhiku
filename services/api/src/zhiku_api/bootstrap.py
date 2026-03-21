from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, UTC
from pathlib import Path
from shutil import which

from .config import AppSettings


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contents (
    id TEXT PRIMARY KEY,
    source_type TEXT,
    platform TEXT,
    source_url TEXT,
    source_file TEXT,
    title TEXT NOT NULL,
    author TEXT,
    content_text TEXT,
    summary TEXT,
    key_points_json TEXT,
    quotes_json TEXT,
    category TEXT,
    content_type TEXT,
    use_case TEXT,
    tags_json TEXT,
    metadata_json TEXT,
    local_path TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS import_jobs (
    id TEXT PRIMARY KEY,
    source_kind TEXT NOT NULL,
    source_value TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    step TEXT,
    preview_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    message_text TEXT NOT NULL,
    citations_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_records (
    id TEXT PRIMARY KEY,
    archive_path TEXT NOT NULL,
    file_size INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_annotations (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    highlight TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(content_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#4f8ef7',
    icon TEXT NOT NULL DEFAULT '◫',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS derived_items (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_chunks (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    heading TEXT,
    chunk_text TEXT NOT NULL,
    summary TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS contents_fts USING fts5(
    title,
    content_text,
    summary
);

CREATE VIRTUAL TABLE IF NOT EXISTS content_chunks_fts USING fts5(
    chunk_text,
    summary,
    content=''
);
"""


@dataclass
class BootstrapStatus:
    database_initialized: bool
    database_path: Path
    ollama_available: bool
    chat_model_ready: bool
    embedding_ready: bool
    ocr_ready: bool


class BootstrapService:
    def __init__(self, settings: AppSettings) -> None:
        self.settings = settings

    def ensure_app_dirs(self) -> None:
        for path in (
            self.settings.app_data_dir,
            self.settings.log_dir,
            self.settings.runtime_dir,
            self.settings.diagnostics_dir,
            self.settings.knowledge_base_dir,
            self.settings.knowledge_base_dir / "contents",
            self.settings.knowledge_base_dir / "db",
            self.settings.knowledge_base_dir / "index",
            self.settings.knowledge_base_dir / "backups",
            self.settings.knowledge_base_dir / "temp",
            self.settings.knowledge_base_dir / "exports",
        ):
            path.mkdir(parents=True, exist_ok=True)

    # 迁移列表：每项为 (version, sql)，按版本顺序执行
    _MIGRATIONS: list[tuple[int, str]] = [
        (1, "ALTER TABLE contents ADD COLUMN collection_id TEXT"),
    ]
    _CURRENT_SCHEMA_VERSION = 1

    def _run_migrations(self, connection: sqlite3.Connection) -> None:
        """版本化迁移：读取 schema_version，顺序执行缺失的迁移，更新版本号。"""
        row = connection.execute(
            "SELECT value_json FROM settings WHERE key = 'schema_version'"
        ).fetchone()
        current_version = int(json.loads(row[0])) if row else 0

        for version, sql in self._MIGRATIONS:
            if version <= current_version:
                continue
            try:
                connection.execute(sql)
            except sqlite3.OperationalError:
                pass  # 列已存在，幂等跳过

        if current_version < self._CURRENT_SCHEMA_VERSION:
            now = datetime.now(UTC).isoformat()
            connection.execute(
                """
                INSERT INTO settings (key, value_json, updated_at)
                VALUES ('schema_version', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
                """,
                (json.dumps(self._CURRENT_SCHEMA_VERSION), now),
            )

    def ensure_database(self) -> None:
        connection = sqlite3.connect(self.settings.db_path)
        try:
            connection.executescript(SCHEMA_SQL)
            self._run_migrations(connection)
            self._rebuild_search_indexes(connection)
            now = datetime.now(UTC).isoformat()
            connection.execute(
                """
                INSERT INTO settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value_json = excluded.value_json,
                    updated_at = excluded.updated_at
                """,
                (
                    "app",
                    json.dumps(
                        {
                            "knowledge_base_dir": str(self.settings.knowledge_base_dir),
                            "chat_model": self.settings.chat_model,
                            "embedding_model": self.settings.embedding_model,
                            "ocr_enabled": self.settings.ocr_enabled,
                        },
                        ensure_ascii=False,
                    ),
                    now,
                ),
            )
            # 记录建立索引时使用的 embedding 模型，用于后续检测模型变更
            index_model_row = connection.execute(
                "SELECT value_json FROM settings WHERE key = 'index_embedding_model'"
            ).fetchone()
            if index_model_row is None:
                connection.execute(
                    "INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)",
                    ("index_embedding_model", json.dumps(self.settings.embedding_model), now),
                )
            connection.commit()
        finally:
            connection.close()

    def _rebuild_search_indexes(self, connection: sqlite3.Connection) -> None:
        # 只在 FTS 行数与源表不一致时才重建，避免每次启动全量重建
        contents_count = connection.execute("SELECT COUNT(*) FROM contents WHERE deleted_at IS NULL").fetchone()[0]
        fts_count = connection.execute("SELECT COUNT(*) FROM contents_fts").fetchone()[0]
        if contents_count != fts_count:
            connection.execute("DELETE FROM contents_fts")
            connection.execute(
                """
                INSERT INTO contents_fts(rowid, title, content_text, summary)
                SELECT rowid, title, COALESCE(content_text, ''), COALESCE(summary, '')
                FROM contents WHERE deleted_at IS NULL
                """
            )

        chunks_count = connection.execute("SELECT COUNT(*) FROM content_chunks").fetchone()[0]
        chunks_fts_count = connection.execute("SELECT COUNT(*) FROM content_chunks_fts").fetchone()[0]
        if chunks_count != chunks_fts_count:
            connection.execute("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES ('delete-all')")
            connection.execute(
                """
                INSERT INTO content_chunks_fts(rowid, chunk_text, summary)
                SELECT rowid, COALESCE(chunk_text, ''), COALESCE(summary, '')
                FROM content_chunks
                """
            )

    def collect_status(self) -> BootstrapStatus:
        ollama_available = which("ollama") is not None
        return BootstrapStatus(
            database_initialized=self.settings.db_path.exists(),
            database_path=self.settings.db_path,
            ollama_available=ollama_available,
            chat_model_ready=False,
            embedding_ready=False,
            ocr_ready=self.settings.ocr_enabled,
        )

    def _cleanup_tmp_dirs(self) -> None:
        """清理超过 7 天未修改的 .tmp_* 目录（在知识库 temp 目录下）。"""
        import shutil
        import time
        cutoff = time.time() - 7 * 86400
        tmp_root = self.settings.knowledge_base_dir / "temp"
        if not tmp_root.exists():
            return
        try:
            for entry in tmp_root.iterdir():
                if entry.is_dir() and entry.name.startswith(".tmp_"):
                    try:
                        if entry.stat().st_mtime < cutoff:
                            shutil.rmtree(entry, ignore_errors=True)
                    except OSError:
                        pass
        except OSError:
            pass

    def initialize(self) -> BootstrapStatus:
        self.ensure_app_dirs()
        self.ensure_database()
        self._cleanup_tmp_dirs()
        return self.collect_status()
