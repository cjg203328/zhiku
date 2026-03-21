from __future__ import annotations

import json
import sqlite3
from datetime import datetime, UTC, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4
import re


CHAT_SESSION_RETENTION_DAYS = 7
IMPORT_TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
CHAT_SESSION_AUTO_SWITCH_THRESHOLD = 20  # 消息数超过此值自动新建 session


class LibraryRepository:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        self._use_uri = self.db_path.startswith("file:")

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, uri=self._use_uri, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def create_import_job(
        self,
        *,
        source_kind: str,
        source_value: str,
        preview: dict[str, Any],
        status: str = "completed",
        progress: int = 100,
        step: str = "preview_ready",
    ) -> dict[str, Any]:
        job_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        payload = {
            "id": job_id,
            "source_kind": source_kind,
            "source_value": source_value,
            "status": status,
            "progress": progress,
            "step": step,
            "preview_json": json.dumps(preview, ensure_ascii=False),
            "error_code": None,
            "error_message": None,
            "created_at": now,
            "updated_at": now,
            "finished_at": now if status in IMPORT_TERMINAL_STATUSES else None,
        }

        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO import_jobs (
                    id, source_kind, source_value, status, progress, step,
                    preview_json, error_code, error_message, created_at,
                    updated_at, finished_at
                ) VALUES (
                    :id, :source_kind, :source_value, :status, :progress, :step,
                    :preview_json, :error_code, :error_message, :created_at,
                    :updated_at, :finished_at
                )
                """,
                payload,
            )
            connection.commit()
        finally:
            connection.close()

        return payload | {"preview": preview}

    def list_import_jobs(self, *, status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            if status:
                rows = connection.execute(
                    "SELECT * FROM import_jobs WHERE status = ? ORDER BY datetime(created_at) DESC LIMIT ?",
                    (status, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM import_jobs ORDER BY datetime(created_at) DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        finally:
            connection.close()
        result = []
        for row in rows:
            data = dict(row)
            data["preview"] = json.loads(data.pop("preview_json") or "{}")
            result.append(data)
        return result

    def get_import_job(self, job_id: str) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM import_jobs WHERE id = ?",
                (job_id,),
            ).fetchone()
        finally:
            connection.close()

        if row is None:
            return None

        data = dict(row)
        data["preview"] = json.loads(data.pop("preview_json") or "{}")
        return data

    def update_import_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        progress: int | None = None,
        step: str | None = None,
        preview: dict[str, Any] | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any] | None:
        current = self.get_import_job(job_id)
        if current is None:
            return None

        next_status = status or str(current.get("status") or "pending")
        next_progress = int(progress if progress is not None else current.get("progress") or 0)
        next_step = step or str(current.get("step") or "")
        next_preview = preview if preview is not None else current.get("preview") or {}
        next_error_code = error_code if error_code is not None else current.get("error_code")
        next_error_message = error_message if error_message is not None else current.get("error_message")
        now = datetime.now(UTC).isoformat()

        connection = self._connect()
        try:
            connection.execute(
                """
                UPDATE import_jobs
                SET status = ?,
                    progress = ?,
                    step = ?,
                    preview_json = ?,
                    error_code = ?,
                    error_message = ?,
                    updated_at = ?,
                    finished_at = ?
                WHERE id = ?
                """,
                (
                    next_status,
                    next_progress,
                    next_step,
                    json.dumps(next_preview, ensure_ascii=False),
                    next_error_code,
                    next_error_message,
                    now,
                    now if next_status in IMPORT_TERMINAL_STATUSES else None,
                    job_id,
                ),
            )
            connection.commit()
        finally:
            connection.close()

        return self.get_import_job(job_id)

    def create_chat_session(self, *, title: str) -> dict[str, Any]:
        self.prune_expired_chat_sessions()
        session_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        payload = {
            "id": session_id,
            "title": title.strip() or "未命名会话",
            "created_at": now,
            "updated_at": now,
        }
        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO chat_sessions (id, title, created_at, updated_at)
                VALUES (:id, :title, :created_at, :updated_at)
                """,
                payload,
            )
            connection.commit()
        finally:
            connection.close()
        return payload

    def append_chat_message(
        self,
        *,
        session_id: str,
        role: str,
        message_text: str,
        citations: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        message_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        payload = {
            "id": message_id,
            "session_id": session_id,
            "role": role,
            "message_text": message_text,
            "citations_json": json.dumps(citations or [], ensure_ascii=False),
            "created_at": now,
        }
        connection = self._connect()
        try:
            connection.execute(
                """
                INSERT INTO chat_messages (id, session_id, role, message_text, citations_json, created_at)
                VALUES (:id, :session_id, :role, :message_text, :citations_json, :created_at)
                """,
                payload,
            )
            connection.execute(
                "UPDATE chat_sessions SET updated_at = ? WHERE id = ?",
                (now, session_id),
            )
            connection.commit()
        finally:
            connection.close()
        return {
            "id": message_id,
            "session_id": session_id,
            "role": role,
            "message_text": message_text,
            "citations": citations or [],
            "created_at": now,
        }

    def save_chat_turn(
        self,
        *,
        question: str,
        answer: str,
        citations: list[dict[str, Any]],
        session_id: str | None = None,
    ) -> dict[str, Any]:
        self.prune_expired_chat_sessions()
        active_session_id = session_id
        auto_switched = False

        if active_session_id:
            existing = self.get_chat_session(active_session_id)
            if existing is None:
                active_session_id = None
            elif len(existing.get("messages") or []) >= CHAT_SESSION_AUTO_SWITCH_THRESHOLD:
                # 上下文过长，自动新建 session
                active_session_id = None
                auto_switched = True

        if active_session_id is None:
            session = self.create_chat_session(title=question[:40])
            active_session_id = session["id"]

        self.append_chat_message(
            session_id=active_session_id,
            role="user",
            message_text=question,
            citations=[],
        )
        self.append_chat_message(
            session_id=active_session_id,
            role="assistant",
            message_text=answer,
            citations=citations,
        )
        session_data = self.get_chat_session(active_session_id) or {"id": active_session_id}
        if auto_switched:
            session_data["auto_switched"] = True
        return session_data

    def list_chat_sessions(self, limit: int = 12) -> dict[str, Any]:
        self.prune_expired_chat_sessions()
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT cs.id,
                       cs.title,
                       cs.created_at,
                       cs.updated_at,
                       COUNT(cm.id) AS message_count,
                       (
                         SELECT message_text
                         FROM chat_messages
                         WHERE session_id = cs.id
                         ORDER BY datetime(created_at) DESC
                         LIMIT 1
                       ) AS last_message
                FROM chat_sessions cs
                LEFT JOIN chat_messages cm ON cm.session_id = cs.id
                GROUP BY cs.id
                ORDER BY datetime(cs.updated_at) DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        finally:
            connection.close()

        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["message_count"] = int(item.get("message_count") or 0)
            item["last_message"] = (item.get("last_message") or "").strip()
            items.append(item)
        return {"items": items, "total": len(items), "retention_days": CHAT_SESSION_RETENTION_DAYS}

    def delete_chat_session(self, session_id: str) -> bool:
        connection = self._connect()
        try:
            existing = connection.execute(
                "SELECT 1 FROM chat_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            if existing is None:
                return False

            connection.execute("DELETE FROM chat_messages WHERE session_id = ?", (session_id,))
            connection.execute("DELETE FROM chat_sessions WHERE id = ?", (session_id,))
            connection.commit()
            return True
        finally:
            connection.close()

    def get_chat_session(self, session_id: str) -> dict[str, Any] | None:
        self.prune_expired_chat_sessions()
        connection = self._connect()
        try:
            session_row = connection.execute(
                "SELECT id, title, created_at, updated_at FROM chat_sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
            message_rows = connection.execute(
                """
                SELECT id, role, message_text, citations_json, created_at
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY datetime(created_at) ASC
                """,
                (session_id,),
            ).fetchall()
        finally:
            connection.close()

        if session_row is None:
            return None

        session = dict(session_row)
        messages: list[dict[str, Any]] = []
        for row in message_rows:
            item = dict(row)
            item["citations"] = json.loads(item.pop("citations_json") or "[]")
            messages.append(item)
        session["messages"] = messages
        return session

    def prune_expired_chat_sessions(self, *, retention_days: int = CHAT_SESSION_RETENTION_DAYS) -> int:
        if retention_days <= 0:
            return 0

        cutoff = (datetime.now(UTC) - timedelta(days=retention_days)).isoformat()
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT id FROM chat_sessions WHERE updated_at < ?",
                (cutoff,),
            ).fetchall()
            if not rows:
                return 0

            session_ids = [(str(row["id"]),) for row in rows if row["id"]]
            if session_ids:
                connection.executemany("DELETE FROM chat_messages WHERE session_id = ?", session_ids)
                connection.executemany("DELETE FROM chat_sessions WHERE id = ?", session_ids)
            connection.commit()
            return len(session_ids)
        finally:
            connection.close()

    def create_content(self, *, content: dict[str, Any]) -> dict[str, Any]:
        content_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        payload = self._build_content_payload(
            content_id=content_id,
            content=content,
            created_at=now,
            updated_at=now,
            deleted_at=None,
        )

        connection = self._connect()
        try:
            cursor = connection.execute(
                """
                INSERT INTO contents (
                    id, source_type, platform, source_url, source_file, title,
                    author, content_text, summary, key_points_json, quotes_json,
                    category, content_type, use_case, tags_json, metadata_json,
                    local_path, status, created_at, updated_at, deleted_at
                ) VALUES (
                    :id, :source_type, :platform, :source_url, :source_file, :title,
                    :author, :content_text, :summary, :key_points_json, :quotes_json,
                    :category, :content_type, :use_case, :tags_json, :metadata_json,
                    :local_path, :status, :created_at, :updated_at, :deleted_at
                )
                """,
                payload,
            )
            rowid = cursor.lastrowid
            connection.execute(
                "INSERT INTO contents_fts(rowid, title, content_text, summary) VALUES (?, ?, ?, ?)",
                (rowid, payload["title"], payload["content_text"], payload["summary"]),
            )
            self._replace_chunks(
                connection,
                content_id=content_id,
                title=payload["title"],
                content_text=payload["content_text"],
                summary=payload["summary"],
                metadata=content.get("metadata", {}),
            )
            connection.commit()
        finally:
            connection.close()

        return self.get_content(content_id) or {"id": content_id}

    def replace_content(self, content_id: str, *, content: dict[str, Any]) -> dict[str, Any] | None:
        existing = self.get_content(content_id)
        if existing is None:
            return None

        payload = self._build_content_payload(
            content_id=content_id,
            content=content,
            created_at=existing["created_at"],
            updated_at=datetime.now(UTC).isoformat(),
            deleted_at=None,
        )

        connection = self._connect()
        try:
            connection.execute(
                """
                UPDATE contents
                SET source_type = :source_type,
                    platform = :platform,
                    source_url = :source_url,
                    source_file = :source_file,
                    title = :title,
                    author = :author,
                    content_text = :content_text,
                    summary = :summary,
                    key_points_json = :key_points_json,
                    quotes_json = :quotes_json,
                    category = :category,
                    content_type = :content_type,
                    use_case = :use_case,
                    tags_json = :tags_json,
                    metadata_json = :metadata_json,
                    local_path = :local_path,
                    status = :status,
                    updated_at = :updated_at,
                    deleted_at = :deleted_at
                WHERE id = :id
                """,
                payload,
            )
            row = connection.execute(
                "SELECT rowid FROM contents WHERE id = ?",
                (content_id,),
            ).fetchone()
            if row is not None:
                connection.execute("DELETE FROM contents_fts WHERE rowid = ?", (row["rowid"],))
                connection.execute(
                    "INSERT INTO contents_fts(rowid, title, content_text, summary) VALUES (?, ?, ?, ?)",
                    (row["rowid"], payload["title"], payload["content_text"], payload["summary"]),
                )
                self._replace_chunks(
                    connection,
                    content_id=content_id,
                    title=payload["title"],
                    content_text=payload["content_text"],
                    summary=payload["summary"],
                    metadata=content.get("metadata", {}),
                )
            connection.commit()
        finally:
            connection.close()

        return self.get_content(content_id)

    def list_contents(self, query: str | None = None, collection_id: str | None = None) -> dict[str, Any]:
        connection = self._connect()
        try:
            params: list[Any] = []
            where_clauses = ["deleted_at IS NULL"]
            if query and query.strip():
                keyword = f"%{query.strip()}%"
                where_clauses.append("(title LIKE ? OR summary LIKE ? OR content_text LIKE ?)")
                params.extend([keyword, keyword, keyword])
            if collection_id is not None:
                where_clauses.append("collection_id = ?")
                params.append(collection_id)
            where_sql = " AND ".join(where_clauses)
            rows = connection.execute(
                f"""
                SELECT id, title, platform, source_type, summary, tags_json, category,
                       collection_id, metadata_json, created_at, updated_at, status
                FROM contents
                WHERE {where_sql}
                ORDER BY datetime(created_at) DESC
                """,
                params,
            ).fetchall()
        finally:
            connection.close()

        items = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json") or "[]")
            metadata = json.loads(item.pop("metadata_json") or "{}")
            item["cover_url"] = metadata.get("cover")
            item["parse_mode"] = metadata.get("parse_mode")
            item["note_style"] = metadata.get("note_style")
            item["collection_id"] = item.get("collection_id")
            items.append(item)
        return {"items": items, "total": len(items)}

    def search_content_chunks(
        self,
        query: str,
        limit: int = 5,
        *,
        content_id: str | None = None,
        chunk_id: str | None = None,
    ) -> list[dict[str, Any]]:
        keyword = query.strip()
        if not keyword and not content_id and not chunk_id:
            return []

        terms = self._extract_search_terms(keyword)

        if chunk_id:
            return self._search_content_chunks_like(
                keyword,
                terms,
                limit=limit,
                content_id=content_id,
                chunk_id=chunk_id,
            )

        if keyword and terms:
            fts_items = self._search_content_chunks_fts(
                keyword,
                terms,
                limit=limit,
                content_id=content_id,
            )
            if fts_items:
                return fts_items

        return self._search_content_chunks_like(
            keyword,
            terms,
            limit=limit,
            content_id=content_id,
            chunk_id=chunk_id,
        )

    def _search_content_chunks_like(
        self,
        keyword: str,
        terms: list[str],
        *,
        limit: int,
        content_id: str | None = None,
        chunk_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if not keyword and not content_id and not chunk_id:
            return []

        where_clauses = ["c.deleted_at IS NULL"]
        parameters: list[Any] = []

        if chunk_id:
            where_clauses.append("cc.id = ?")
            parameters.append(chunk_id)
        elif content_id:
            where_clauses.append("c.id = ?")
            parameters.append(content_id)
        else:
            chunk_clauses: list[str] = []
            for term in terms:
                chunk_clauses.append(
                    "(cc.chunk_text LIKE ? OR cc.summary LIKE ? OR c.title LIKE ? OR c.summary LIKE ?)"
                )
                parameters.extend([f"%{term}%", f"%{term}%", f"%{term}%", f"%{term}%"])
            where_clauses.append(f"({' OR '.join(chunk_clauses)})")

        connection = self._connect()
        try:
            rows = connection.execute(
                f"""
                SELECT cc.id AS chunk_id,
                       cc.content_id,
                       cc.chunk_index,
                       cc.heading,
                       cc.chunk_text,
                       cc.summary AS chunk_summary,
                       cc.metadata_json AS chunk_metadata_json,
                       c.title,
                       c.platform,
                       c.status,
                       c.source_type,
                       c.source_url,
                       c.summary,
                       c.metadata_json AS content_metadata_json
                FROM content_chunks cc
                JOIN contents c ON c.id = cc.content_id
                WHERE {' AND '.join(where_clauses)}
                ORDER BY cc.chunk_index ASC
                """,
                parameters,
            ).fetchall()
        finally:
            connection.close()

        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["chunk_metadata"] = json.loads(item.pop("chunk_metadata_json") or "{}")
            item["metadata"] = json.loads(item.pop("content_metadata_json") or "{}")
            item["score"] = self._score_chunk_match(item, terms) if terms else 0
            item["snippet"] = self._build_chunk_snippet(item, keyword) if keyword else item.get("chunk_summary") or item.get("chunk_text") or ""
            items.append(item)

        items.sort(key=lambda item: (item["score"], -item.get("chunk_index", 0)), reverse=True)
        return items[:limit]

    def search_contents(self, query: str, limit: int = 5) -> list[dict[str, Any]]:
        keyword = query.strip()
        if not keyword:
            return []

        terms = self._extract_search_terms(keyword)
        fts_items = self._search_contents_fts(keyword, terms, limit=limit)
        if fts_items:
            return fts_items

        return self._search_contents_like(keyword, terms, limit=limit)

    def _search_contents_like(self, keyword: str, terms: list[str], *, limit: int) -> list[dict[str, Any]]:
        where_clauses = ["deleted_at IS NULL"]
        parameters: list[str] = []
        content_clauses: list[str] = []
        for term in terms:
            content_clauses.append("(title LIKE ? OR summary LIKE ? OR content_text LIKE ? OR tags_json LIKE ?)")
            parameters.extend([f"%{term}%", f"%{term}%", f"%{term}%", f"%{term}%"])
        where_clauses.append(f"({' OR '.join(content_clauses)})")

        connection = self._connect()
        try:
            rows = connection.execute(
                f"""
                SELECT id, title, platform, source_type, summary, content_text, tags_json, category,
                       source_url, created_at, updated_at, status, metadata_json
                FROM contents
                WHERE {' AND '.join(where_clauses)}
                ORDER BY datetime(created_at) DESC
                """,
                parameters,
            ).fetchall()
        finally:
            connection.close()

        items: list[dict[str, Any]] = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json") or "[]")
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            score = self._score_match(item, terms)
            item["score"] = score
            item["snippet"] = self._build_snippet(item, keyword)
            items.append(item)

        items.sort(key=lambda item: item["score"], reverse=True)
        return items[:limit]

    def _search_contents_fts(self, keyword: str, terms: list[str], *, limit: int) -> list[dict[str, Any]]:
        fts_query = self._build_fts_query(keyword, terms)
        if not fts_query:
            return []

        connection = self._connect()
        try:
            try:
                rows = connection.execute(
                    """
                    SELECT c.id,
                           c.title,
                           c.platform,
                           c.source_type,
                           c.summary,
                           c.content_text,
                           c.tags_json,
                           c.category,
                           c.source_url,
                           c.created_at,
                           c.updated_at,
                           c.status,
                           c.metadata_json,
                           bm25(contents_fts, 8.0, 3.0, 2.0) AS fts_rank
                    FROM contents_fts
                    JOIN contents c ON c.rowid = contents_fts.rowid
                    WHERE c.deleted_at IS NULL
                      AND contents_fts MATCH ?
                    ORDER BY bm25(contents_fts, 8.0, 3.0, 2.0) ASC, datetime(c.created_at) DESC
                    LIMIT ?
                    """,
                    (fts_query, max(limit * 3, limit)),
                ).fetchall()
            except sqlite3.OperationalError:
                return []
        finally:
            connection.close()

        items: list[dict[str, Any]] = []
        for rank, row in enumerate(rows):
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json") or "[]")
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            heuristic_score = self._score_match(item, terms)
            item["score"] = heuristic_score + max(24, 120 - rank * 8)
            item["snippet"] = self._build_snippet(item, keyword)
            items.append(item)

        items.sort(key=lambda item: item["score"], reverse=True)
        return items[:limit]

    def _search_content_chunks_fts(
        self,
        keyword: str,
        terms: list[str],
        *,
        limit: int,
        content_id: str | None = None,
    ) -> list[dict[str, Any]]:
        fts_query = self._build_fts_query(keyword, terms)
        if not fts_query:
            return []

        where_clauses = ["c.deleted_at IS NULL", "content_chunks_fts MATCH ?"]
        parameters: list[Any] = [fts_query]
        if content_id:
            where_clauses.append("c.id = ?")
            parameters.append(content_id)

        connection = self._connect()
        try:
            try:
                rows = connection.execute(
                    f"""
                    SELECT cc.id AS chunk_id,
                           cc.content_id,
                           cc.chunk_index,
                           cc.heading,
                           cc.chunk_text,
                           cc.summary AS chunk_summary,
                           cc.metadata_json AS chunk_metadata_json,
                           c.title,
                           c.platform,
                           c.status,
                           c.source_type,
                           c.source_url,
                           c.summary,
                           c.metadata_json AS content_metadata_json,
                           bm25(content_chunks_fts, 6.0, 2.0) AS fts_rank
                    FROM content_chunks_fts
                    JOIN content_chunks cc ON cc.rowid = content_chunks_fts.rowid
                    JOIN contents c ON c.id = cc.content_id
                    WHERE {' AND '.join(where_clauses)}
                    ORDER BY bm25(content_chunks_fts, 6.0, 2.0) ASC, cc.chunk_index ASC
                    LIMIT ?
                    """,
                    [*parameters, max(limit * 3, limit)],
                ).fetchall()
            except sqlite3.OperationalError:
                return []
        finally:
            connection.close()

        items: list[dict[str, Any]] = []
        for rank, row in enumerate(rows):
            item = dict(row)
            item["chunk_metadata"] = json.loads(item.pop("chunk_metadata_json") or "{}")
            item["metadata"] = json.loads(item.pop("content_metadata_json") or "{}")
            heuristic_score = self._score_chunk_match(item, terms)
            item["score"] = heuristic_score + max(28, 128 - rank * 8)
            item["snippet"] = self._build_chunk_snippet(item, keyword)
            items.append(item)

        items.sort(key=lambda item: (item["score"], -item.get("chunk_index", 0)), reverse=True)
        return items[:limit]

    def list_deleted_contents(self) -> dict[str, Any]:
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT id, title, platform, source_type, summary, tags_json, category,
                       metadata_json, created_at, updated_at, status, deleted_at
                FROM contents
                WHERE deleted_at IS NOT NULL
                ORDER BY datetime(deleted_at) DESC
                """
            ).fetchall()
        finally:
            connection.close()

        items = []
        for row in rows:
            item = dict(row)
            item["tags"] = json.loads(item.pop("tags_json") or "[]")
            metadata = json.loads(item.pop("metadata_json") or "{}")
            item["cover_url"] = metadata.get("cover")
            item["parse_mode"] = metadata.get("parse_mode")
            item["note_style"] = metadata.get("note_style")
            item["collection_id"] = item.get("collection_id")
            items.append(item)
        return {"items": items, "total": len(items)}

    def _score_match(self, item: dict[str, Any], terms: list[str]) -> int:
        title = (item.get("title") or "").lower()
        summary = (item.get("summary") or "").lower()
        content_text = (item.get("content_text") or "").lower()
        tags = " ".join(item.get("tags") or []).lower()
        score = 0
        for term in terms:
            lowered = term.lower()
            score += title.count(lowered) * 5
            score += summary.count(lowered) * 3
            score += content_text.count(lowered)
            score += tags.count(lowered) * 4
        return score

    def _extract_search_terms(self, query: str) -> list[str]:
        keyword = (query or "").strip()
        if not keyword:
            return []

        latin_terms = [item.lower() for item in re.findall(r"[A-Za-z0-9][A-Za-z0-9_\-\.]{1,31}", keyword)]
        han_blocks = re.findall(r"[\u4e00-\u9fff]{2,16}", keyword)
        han_terms: list[str] = []
        for block in han_blocks:
            if len(block) <= 4:
                han_terms.append(block)
                continue
            for size in (4, 3, 2):
                for index in range(0, len(block) - size + 1):
                    han_terms.append(block[index:index + size])

        ordered_terms: list[str] = []
        for term in [keyword, *latin_terms, *han_terms]:
            cleaned = term.strip().lower()
            if len(cleaned) < 2:
                continue
            if cleaned not in ordered_terms:
                ordered_terms.append(cleaned)
        if not ordered_terms and keyword:
            return [keyword.lower()]
        return ordered_terms[:12]

    def _build_fts_query(self, keyword: str, terms: list[str]) -> str:
        candidates: list[str] = []
        lead = keyword.strip()
        if lead:
            candidates.append(lead)
        candidates.extend(item for item in terms if item and item not in candidates)

        phrases: list[str] = []
        for term in candidates[:6]:
            cleaned = re.sub(r"\s+", " ", str(term or "").strip())
            if len(cleaned) < 2:
                continue
            escaped = cleaned.replace('"', '""')
            phrases.append(f'"{escaped}"')
        return " OR ".join(phrases)

    def _build_snippet(self, item: dict[str, Any], query: str) -> str:
        source = item.get("content_text") or item.get("summary") or item.get("title") or ""
        if not source:
            return ""
        lowered = source.lower()
        index = lowered.find(query.lower())
        if index < 0:
            return source[:120] + ("..." if len(source) > 120 else "")
        start = max(0, index - 40)
        end = min(len(source), index + 80)
        snippet = source[start:end].strip()
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(source) else ""
        return f"{prefix}{snippet}{suffix}"

    def get_content(self, content_id: str) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM contents WHERE id = ? AND deleted_at IS NULL",
                (content_id,),
            ).fetchone()
            chunk_rows = connection.execute(
                "SELECT id, chunk_index, heading, chunk_text, summary, metadata_json FROM content_chunks WHERE content_id = ? ORDER BY chunk_index ASC",
                (content_id,),
            ).fetchall()
        finally:
            connection.close()

        if row is None:
            return None

        data = dict(row)
        data["key_points"] = json.loads(data.pop("key_points_json") or "[]")
        data["quotes"] = json.loads(data.pop("quotes_json") or "[]")
        data["tags"] = json.loads(data.pop("tags_json") or "[]")
        data["metadata"] = json.loads(data.pop("metadata_json") or "{}")
        chunks: list[dict[str, Any]] = []
        for chunk_row in chunk_rows:
            chunk_item = dict(chunk_row)
            chunk_item["metadata"] = json.loads(chunk_item.pop("metadata_json") or "{}")
            chunks.append(chunk_item)
        data["chunks"] = chunks
        return data

    def update_content(
        self,
        content_id: str,
        *,
        title: str | None = None,
        summary: str | None = None,
        category: str | None = None,
        tags: list[str] | None = None,
        annotations: dict | None = None,
    ) -> dict[str, Any] | None:
        existing = self.get_content(content_id)
        if existing is None:
            return None

        payload = {
            "id": content_id,
            "title": title or existing["title"],
            "summary": summary or existing["summary"],
            "category": category or existing["category"],
            "tags_json": json.dumps(tags if tags is not None else existing["tags"], ensure_ascii=False),
            "updated_at": datetime.now(UTC).isoformat(),
        }

        connection = self._connect()
        try:
            connection.execute(
                """
                UPDATE contents
                SET title = :title,
                    summary = :summary,
                    category = :category,
                    tags_json = :tags_json,
                    updated_at = :updated_at
                WHERE id = :id
                """,
                payload,
            )
            row = connection.execute(
                "SELECT rowid, content_text, metadata_json FROM contents WHERE id = ?",
                (content_id,),
            ).fetchone()
            if row is not None:
                if annotations is not None:
                    meta = json.loads(row["metadata_json"] or "{}")
                    meta["user_annotations"] = annotations
                    connection.execute(
                        "UPDATE contents SET metadata_json = ? WHERE id = ?",
                        (json.dumps(meta, ensure_ascii=False), content_id),
                    )
                connection.execute("DELETE FROM contents_fts WHERE rowid = ?", (row["rowid"],))
                connection.execute(
                    "INSERT INTO contents_fts(rowid, title, content_text, summary) VALUES (?, ?, ?, ?)",
                    (row["rowid"], payload["title"], row["content_text"], payload["summary"]),
                )
                self._replace_chunks(
                    connection,
                    content_id=content_id,
                    title=payload["title"],
                    content_text=row["content_text"],
                    summary=payload["summary"],
                    metadata=json.loads(row["metadata_json"] or "{}"),
                )
            connection.commit()
        finally:
            connection.close()

        return self.get_content(content_id)

    def soft_delete_content(self, content_id: str) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "UPDATE contents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (
                    datetime.now(UTC).isoformat(),
                    datetime.now(UTC).isoformat(),
                    content_id,
                ),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    def restore_content(self, content_id: str) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "UPDATE contents SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
                (
                    datetime.now(UTC).isoformat(),
                    content_id,
                ),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    def empty_trash(self) -> int:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT id, rowid FROM contents WHERE deleted_at IS NOT NULL"
            ).fetchall()
            if not rows:
                return 0

            content_ids = [(str(row["id"]),) for row in rows if row["id"]]
            rowids = [(int(row["rowid"]),) for row in rows if row["rowid"] is not None]

            if content_ids:
                connection.executemany("DELETE FROM content_chunks WHERE content_id = ?", content_ids)
                self._rebuild_chunk_search_index(connection)
            if rowids:
                connection.executemany("DELETE FROM contents_fts WHERE rowid = ?", rowids)
            connection.execute("DELETE FROM contents WHERE deleted_at IS NOT NULL")
            connection.commit()
            return len(rows)
        finally:
            connection.close()

    def permanent_delete_content(self, content_id: str) -> bool:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT rowid FROM contents WHERE id = ? AND deleted_at IS NOT NULL",
                (content_id,),
            ).fetchone()
            if row is None:
                return False
            connection.execute("DELETE FROM content_chunks WHERE content_id = ?", (content_id,))
            connection.execute("DELETE FROM contents_fts WHERE rowid = ?", (row["rowid"],))
            connection.execute("DELETE FROM contents WHERE id = ?", (content_id,))
            connection.commit()
            return True
        finally:
            connection.close()

    def _replace_chunks(
        self,
        connection: sqlite3.Connection,
        *,
        content_id: str,
        title: str,
        content_text: str,
        summary: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        connection.execute("DELETE FROM content_chunks WHERE content_id = ?", (content_id,))

        transcript_chunks = self._build_transcript_chunks(metadata or {})
        chunks = transcript_chunks or self._chunk_text(title=title, content_text=content_text, summary=summary)
        now = datetime.now(UTC).isoformat()
        for chunk in chunks:
            chunk_id = str(uuid4())
            chunk_metadata = chunk.get("metadata", {"source": "auto_chunk"})
            metadata_json = json.dumps(chunk_metadata, ensure_ascii=False)
            connection.execute(
                """
                INSERT INTO content_chunks (
                    id, content_id, chunk_index, heading, chunk_text, summary, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk_id,
                    content_id,
                    chunk["chunk_index"],
                    chunk.get("heading"),
                    chunk["chunk_text"],
                    chunk["summary"],
                    metadata_json,
                    now,
                    now,
                ),
            )
        self._rebuild_chunk_search_index(connection)

    def _rebuild_chunk_search_index(self, connection: sqlite3.Connection) -> None:
        connection.execute("INSERT INTO content_chunks_fts(content_chunks_fts) VALUES ('delete-all')")
        connection.execute(
            """
            INSERT INTO content_chunks_fts(rowid, chunk_text, summary)
            SELECT rowid, COALESCE(chunk_text, ''), COALESCE(summary, '')
            FROM content_chunks
            """
        )

    def _build_content_payload(
        self,
        *,
        content_id: str,
        content: dict[str, Any],
        created_at: str,
        updated_at: str,
        deleted_at: str | None,
    ) -> dict[str, Any]:
        return {
            "id": content_id,
            "source_type": content.get("source_type"),
            "platform": content.get("platform"),
            "source_url": content.get("source_url"),
            "source_file": content.get("source_file"),
            "title": content.get("title") or "未命名内容",
            "author": content.get("author"),
            "content_text": content.get("content_text") or "",
            "summary": content.get("summary") or "",
            "key_points_json": json.dumps(content.get("key_points", []), ensure_ascii=False),
            "quotes_json": json.dumps(content.get("quotes", []), ensure_ascii=False),
            "category": content.get("category") or "未分类",
            "content_type": content.get("content_type") or "笔记",
            "use_case": content.get("use_case") or "参考",
            "tags_json": json.dumps(content.get("tags", []), ensure_ascii=False),
            "metadata_json": json.dumps(content.get("metadata", {}), ensure_ascii=False),
            "local_path": content.get("local_path"),
            "status": content.get("status") or "ready",
            "created_at": created_at,
            "updated_at": updated_at,
            "deleted_at": deleted_at,
        }

    def _build_transcript_chunks(self, metadata: dict[str, Any]) -> list[dict[str, Any]]:
        semantic_segments = metadata.get("semantic_transcript_segments")
        use_semantic_segments = isinstance(semantic_segments, list) and any(
            isinstance(item, dict) and str(item.get("text") or "").strip() for item in semantic_segments
        )
        raw_segments = semantic_segments if use_semantic_segments else metadata.get("transcript_segments")
        if not isinstance(raw_segments, list):
            return []

        chunks: list[dict[str, Any]] = []
        for index, item in enumerate(raw_segments):
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue

            start_ms = self._coerce_milliseconds(item.get("start_ms"))
            end_ms = self._coerce_milliseconds(item.get("end_ms"))
            timestamp_label = str(item.get("timestamp_label") or "").strip() or self._format_segment_range(start_ms, end_ms)
            heading = timestamp_label or f"片段 {index + 1}"
            chunks.append(
                {
                    "chunk_index": index,
                    "heading": heading,
                    "chunk_text": text,
                    "summary": self._summarize_chunk(text),
                    "metadata": {
                        "source": "semantic_transcript_segment" if use_semantic_segments else "transcript_segment",
                        "start_ms": start_ms,
                        "end_ms": end_ms,
                        "timestamp_label": timestamp_label,
                        "seek_url": str(item.get("seek_url") or "").strip() or None,
                        "source_kind": str(item.get("source_kind") or "transcript"),
                        "quality_level": str(item.get("quality_level") or "unknown"),
                    },
                }
            )
        return chunks

    def _chunk_text(self, *, title: str, content_text: str, summary: str) -> list[dict[str, Any]]:
        source = (content_text or "").strip() or (summary or "").strip()
        if not source:
            return [{"chunk_index": 0, "heading": title or "未命名内容", "chunk_text": "当前没有可切分的正文。", "summary": summary or ""}]

        paragraphs = [part.strip() for part in re.split(r"\n{2,}", source) if part.strip()]
        if not paragraphs:
            paragraphs = [part.strip() for part in source.splitlines() if part.strip()]

        chunks: list[dict[str, Any]] = []
        buffer: list[str] = []
        buffer_length = 0
        chunk_index = 0
        for paragraph in paragraphs:
            candidate_length = buffer_length + len(paragraph)
            if buffer and candidate_length > 320:
                chunk_text = "\n\n".join(buffer)
                chunks.append({
                    "chunk_index": chunk_index,
                    "heading": f"片段 {chunk_index + 1}",
                    "chunk_text": chunk_text,
                    "summary": self._summarize_chunk(chunk_text),
                })
                chunk_index += 1
                buffer = [paragraph]
                buffer_length = len(paragraph)
            else:
                buffer.append(paragraph)
                buffer_length = candidate_length

        if buffer:
            chunk_text = "\n\n".join(buffer)
            chunks.append({
                "chunk_index": chunk_index,
                "heading": f"片段 {chunk_index + 1}",
                "chunk_text": chunk_text,
                "summary": self._summarize_chunk(chunk_text),
            })

        return chunks or [{"chunk_index": 0, "heading": title or "未命名内容", "chunk_text": source, "summary": self._summarize_chunk(source)}]

    def _coerce_milliseconds(self, value: Any) -> int | None:
        if value is None:
            return None
        try:
            milliseconds = int(value)
        except (TypeError, ValueError):
            return None
        return milliseconds if milliseconds >= 0 else None

    def _format_segment_range(self, start_ms: int | None, end_ms: int | None) -> str:
        if start_ms is None and end_ms is None:
            return ""
        start_label = self._format_timestamp(start_ms)
        end_label = self._format_timestamp(end_ms)
        if start_label and end_label:
            return f"{start_label} - {end_label}"
        return start_label or end_label

    def _format_timestamp(self, value_ms: int | None) -> str:
        if value_ms is None:
            return ""
        total_seconds = int(value_ms // 1000)
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
        return f"{minutes:02d}:{seconds:02d}"

    def _summarize_chunk(self, text: str) -> str:
        compact = text.replace("\n", " ").strip()
        return compact[:100] + ("..." if len(compact) > 100 else "")

    def _score_chunk_match(self, item: dict[str, Any], terms: list[str]) -> int:
        title = (item.get("title") or "").lower()
        chunk_text = (item.get("chunk_text") or "").lower()
        chunk_summary = (item.get("chunk_summary") or "").lower()
        score = 0
        for term in terms:
            lowered = term.lower()
            score += title.count(lowered) * 4
            score += chunk_summary.count(lowered) * 3
            score += chunk_text.count(lowered) * 2
        return score

    def _build_chunk_snippet(self, item: dict[str, Any], query: str) -> str:
        source = item.get("chunk_text") or item.get("chunk_summary") or item.get("title") or ""
        lowered = source.lower()
        index = lowered.find(query.lower())
        if index < 0:
            return source[:140] + ("..." if len(source) > 140 else "")
        start = max(0, index - 50)
        end = min(len(source), index + 90)
        snippet = source[start:end].strip()
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(source) else ""
        return f"{prefix}{snippet}{suffix}"

    def get_chunks_by_content_id(self, content_id: str, limit: int = 12) -> list[dict[str, Any]]:
        """直接按 content_id 取前 N 条 chunk，不依赖搜索关键词。"""
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT id, content_id, chunk_index, heading, chunk_text, summary, metadata_json
                FROM content_chunks
                WHERE content_id = ?
                ORDER BY chunk_index ASC
                LIMIT ?
                """,
                (content_id, limit),
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                try:
                    item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
                except Exception:
                    item["metadata"] = {}
                result.append(item)
            return result
        finally:
            connection.close()

    # ------------------------------------------------------------------ #
    # Collections                                                          #
    # ------------------------------------------------------------------ #

    def list_collections(self) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT id, name, description, color, icon, created_at, updated_at FROM collections ORDER BY created_at ASC"
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()

    def create_collection(self, *, name: str, description: str = "", color: str = "#4f8ef7", icon: str = "◫") -> dict[str, Any]:
        collection_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        row = {"id": collection_id, "name": name, "description": description, "color": color, "icon": icon, "created_at": now, "updated_at": now}
        connection = self._connect()
        try:
            connection.execute(
                "INSERT INTO collections (id, name, description, color, icon, created_at, updated_at) VALUES (:id, :name, :description, :color, :icon, :created_at, :updated_at)",
                row,
            )
            connection.commit()
        finally:
            connection.close()
        return row

    def update_collection(self, collection_id: str, *, name: str | None = None, description: str | None = None, color: str | None = None, icon: str | None = None) -> dict[str, Any] | None:
        connection = self._connect()
        try:
            row = connection.execute("SELECT * FROM collections WHERE id = ?", (collection_id,)).fetchone()
            if row is None:
                return None
            current = dict(row)
            now = datetime.now(UTC).isoformat()
            connection.execute(
                "UPDATE collections SET name=?, description=?, color=?, icon=?, updated_at=? WHERE id=?",
                (
                    name if name is not None else current["name"],
                    description if description is not None else current["description"],
                    color if color is not None else current["color"],
                    icon if icon is not None else current["icon"],
                    now,
                    collection_id,
                ),
            )
            connection.commit()
            return {**current, "name": name or current["name"], "description": description or current["description"], "color": color or current["color"], "icon": icon or current["icon"], "updated_at": now}
        finally:
            connection.close()

    def delete_collection(self, collection_id: str) -> bool:
        connection = self._connect()
        try:
            connection.execute("UPDATE contents SET collection_id = NULL WHERE collection_id = ?", (collection_id,))
            cursor = connection.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    def assign_content_collection(self, content_id: str, collection_id: str | None) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute(
                "UPDATE contents SET collection_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (collection_id, datetime.now(UTC).isoformat(), content_id),
            )
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()

    # ------------------------------------------------------------------ #
    # Derived items (mindmap / quiz)                                       #
    # ------------------------------------------------------------------ #

    def list_derived_items(self, content_id: str) -> list[dict[str, Any]]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT id, content_id, kind, title, data_json, status, error_message, created_at, updated_at FROM derived_items WHERE content_id = ? ORDER BY created_at DESC",
                (content_id,),
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                try:
                    item["data"] = json.loads(item.pop("data_json") or "{}")
                except Exception:
                    item["data"] = {}
                result.append(item)
            return result
        finally:
            connection.close()

    def create_derived_item(self, *, content_id: str, kind: str, title: str, data: dict[str, Any], status: str = "completed") -> dict[str, Any]:
        item_id = str(uuid4())
        now = datetime.now(UTC).isoformat()
        connection = self._connect()
        try:
            connection.execute(
                "INSERT INTO derived_items (id, content_id, kind, title, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (item_id, content_id, kind, title, json.dumps(data, ensure_ascii=False), status, now, now),
            )
            connection.commit()
        finally:
            connection.close()
        return {"id": item_id, "content_id": content_id, "kind": kind, "title": title, "data": data, "status": status, "created_at": now, "updated_at": now}

    def delete_derived_item(self, item_id: str) -> bool:
        connection = self._connect()
        try:
            cursor = connection.execute("DELETE FROM derived_items WHERE id = ?", (item_id,))
            connection.commit()
            return cursor.rowcount > 0
        finally:
            connection.close()
