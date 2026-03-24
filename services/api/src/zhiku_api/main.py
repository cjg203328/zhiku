import uuid
from contextvars import ContextVar

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .app_state import AppState
from .config import get_settings
from .logging_setup import configure_logging
from .routers import backups, bilibili_bridge, chat, collections, contents, derive, diagnostics, health, imports, models, settings, system

request_trace_id: ContextVar[str] = ContextVar("request_trace_id", default="-")


class TraceIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        trace_id = request.headers.get("X-Trace-Id") or uuid.uuid4().hex[:12]
        token = request_trace_id.set(trace_id)
        response = await call_next(request)
        response.headers["X-Trace-Id"] = trace_id
        request_trace_id.reset(token)
        return response


def create_app() -> FastAPI:
    settings_obj = get_settings()
    configure_logging(settings_obj)
    container = AppState.create(settings_obj)

    app = FastAPI(
        title="Zhiku API",
        version=settings_obj.app_version,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.add_middleware(TraceIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:1420", "http://localhost:1420"],
        allow_origin_regex=r"^(https?://(?:127\.0\.0\.1|localhost)(?::\d+)?|chrome-extension://.*|moz-extension://.*)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.container = container
    static_dir = settings_obj.knowledge_base_dir / "static"
    static_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    app.include_router(health.router)
    app.include_router(system.router)
    app.include_router(settings.router)
    app.include_router(bilibili_bridge.router)
    app.include_router(models.router)
    app.include_router(imports.router)
    app.include_router(contents.router)
    app.include_router(collections.router)
    app.include_router(derive.router)
    app.include_router(chat.router)
    app.include_router(backups.router)
    app.include_router(diagnostics.router)

    return app


app = create_app()
