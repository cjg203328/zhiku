import json
import sqlite3

from fastapi import APIRouter, BackgroundTasks, Request

from ..bootstrap import BootstrapService
from ..repositories import LibraryRepository
from ..services import AsrRuntimeService, ModelStatusService

router = APIRouter(prefix="/api/v1/system", tags=["system"])


def _get_setting_value(repository: LibraryRepository, key: str):
    """从 settings 表读取单个配置值，失败返回 None。"""
    connection = repository._connect()
    try:
        row = connection.execute(
            "SELECT value_json FROM settings WHERE key = ?", (key,)
        ).fetchone()
        return json.loads(row[0]) if row else None
    except Exception:
        return None
    finally:
        connection.close()


def _get_chunks_count(repository: LibraryRepository) -> int:
    connection = repository._connect()
    try:
        return connection.execute("SELECT COUNT(*) FROM content_chunks").fetchone()[0]
    except Exception:
        return 0
    finally:
        connection.close()


@router.get("/status")
def get_system_status(request: Request) -> dict:
    container = request.app.state.container
    settings = container.settings
    model_status = ModelStatusService(
        provider=settings.model_provider,
        chat_model=settings.chat_model,
        embedding_model=settings.embedding_model,
        llm_api_base_url=settings.llm_api_base_url,
        llm_api_key=settings.llm_api_key,
        ocr_enabled=settings.ocr_enabled,
    ).collect()
    asr_status = AsrRuntimeService(settings).build_status_payload()

    repository = LibraryRepository(settings.db_path)

    # 检测 embedding 模型是否与建索引时一致
    index_embedding_model = _get_setting_value(repository, "index_embedding_model")
    embedding_model_mismatch = (
        index_embedding_model is not None
        and index_embedding_model != settings.embedding_model
    )

    # FAISS 一致性检查
    faiss_index_path = settings.faiss_index_path
    faiss_index_exists = faiss_index_path.exists()
    chunks_count = _get_chunks_count(repository)
    faiss_needs_rebuild = chunks_count > 0 and not faiss_index_exists

    return {
        "service_status": "ready",
        "knowledge_base_dir": str(settings.knowledge_base_dir),
        "models": {
            "provider": model_status.provider,
            "provider_ready": model_status.provider_ready,
            "ollama_available": model_status.ollama_available,
            "chat_model_ready": model_status.chat_model_ready,
            "embedding_ready": model_status.embedding_ready,
            "ocr_ready": model_status.ocr_ready,
            "embedding_model": settings.embedding_model,
            "index_embedding_model": index_embedding_model,
            "embedding_model_mismatch": embedding_model_mismatch,
        },
        "asr": asr_status,
        "database": {
            "initialized": settings.db_path.exists(),
            "path": str(settings.db_path),
        },
        "index": {
            "faiss_exists": faiss_index_exists,
            "chunks_count": chunks_count,
            "needs_rebuild": faiss_needs_rebuild,
        },
    }


@router.post("/reindex")
def reindex(request: Request, background_tasks: BackgroundTasks) -> dict:
    """重建 FTS 全文索引和 FAISS 向量索引（异步执行）。"""
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)
    chunks_count = _get_chunks_count(repository)

    def _do_reindex() -> None:
        bootstrap = BootstrapService(settings)
        conn = repository._connect()
        try:
            bootstrap._rebuild_search_indexes(conn)
            conn.commit()
        finally:
            conn.close()
        # 重置 index_embedding_model 为当前模型
        import json as _json
        from datetime import datetime, UTC
        conn2 = repository._connect()
        try:
            now = datetime.now(UTC).isoformat()
            conn2.execute(
                """
                INSERT INTO settings (key, value_json, updated_at)
                VALUES ('index_embedding_model', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
                """,
                (_json.dumps(settings.embedding_model), now),
            )
            conn2.commit()
        finally:
            conn2.close()

    background_tasks.add_task(_do_reindex)
    return {
        "ok": True,
        "chunks_count": chunks_count,
        "message": f"已触发索引重建，共 {chunks_count} 条片段，后台执行中。",
    }


@router.get("/bilibili-status")
def get_bilibili_status(request: Request) -> dict:
    """返回 B站 Cookie 配置状态。"""
    container = request.app.state.container
    settings = container.settings
    bridge_status = container.bilibili_session_broker.build_browser_bridge_status()
    return {
        "browser_bridge_enabled": settings.bilibili_browser_bridge_enabled,
        "browser_bridge_active": bridge_status["browser_bridge_active"],
        "browser_bridge_available": bridge_status["browser_bridge_available"],
        "browser_bridge_source_label": bridge_status["browser_bridge_source_label"],
        "browser_bridge_summary": bridge_status["browser_bridge_summary"],
        "browser_bridge_last_seen": bridge_status["browser_bridge_last_seen"],
        "browser_bridge_expires_at": bridge_status["browser_bridge_expires_at"],
        "cookie_configured": settings.bilibili_cookie_configured,
        "cookie_enabled": settings.bilibili_cookie_enabled,
        "cookie_active": settings.bilibili_cookie_active,
        "cookie_source": settings.bilibili_cookie_source,
    }


@router.post("/init-samples")
def init_samples(request: Request) -> dict:
    """插入示例内容，帮助用户在首次引导时验证知识库基本功能。"""
    settings = request.app.state.container.settings
    repository = LibraryRepository(settings.db_path)

    existing = repository.list_contents(limit=1)
    if existing.get("total", 0) > 0:
        return {"ok": True, "inserted": 0, "message": "知识库已有内容，跳过示例插入。"}

    samples = [
        {
            "source_type": "manual",
            "platform": "示例",
            "title": "知库使用指南（示例）",
            "summary": "这是一条示例内容，帮助你快速验证知识库的导入、笔记和问答功能是否正常工作。",
            "content_text": (
                "知库是一个本地优先的个人知识库工具，支持 B 站视频、本地文件和网页内容的导入。\n\n"
                "主要功能包括：\n"
                "1. 自动生成结构化笔记和摘要\n"
                "2. 基于内容的智能问答（RAG）\n"
                "3. 片段高亮和批注\n"
                "4. 全文搜索和向量检索\n\n"
                "建议先导入一条 B 站知识讲解视频，体验完整链路。"
            ),
            "key_points": [
                "先确认服务状态和模型配置",
                "导入公开视频或本地文件，优先选表达清晰的内容",
                "通过问答验证笔记质量和引用效果",
            ],
            "tags": ["示例", "入门"],
            "category": "教程",
            "status": "completed",
            "metadata": {"is_sample": True},
        }
    ]

    inserted = 0
    for sample in samples:
        repository.create_content(content=sample)
        inserted += 1

    return {"ok": True, "inserted": inserted, "message": f"已插入 {inserted} 条示例内容。"}
