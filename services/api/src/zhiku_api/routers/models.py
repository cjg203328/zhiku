from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..services import DiagnosticsService, ModelStatusService

router = APIRouter(prefix="/api/v1/models", tags=["models"])


class ModelCatalogRequest(BaseModel):
    provider: str = "openai_compatible"
    api_base_url: str = Field(min_length=1)
    api_key: str | None = None


@router.get("/status")
def get_models_status(request: Request) -> dict:
    settings = request.app.state.container.settings
    status = ModelStatusService(
        provider=settings.model_provider,
        chat_model=settings.chat_model,
        embedding_model=settings.embedding_model,
        llm_api_base_url=settings.llm_api_base_url,
        llm_api_key=settings.llm_api_key,
        ocr_enabled=settings.ocr_enabled,
    ).collect()

    return {
        "provider": status.provider,
        "provider_ready": status.provider_ready,
        "ollama_available": status.ollama_available,
        "ollama_version": status.ollama_version,
        "chat_model": settings.chat_model,
        "chat_model_ready": status.chat_model_ready,
        "embedding_model": settings.embedding_model,
        "embedding_ready": status.embedding_ready,
        "ocr_ready": status.ocr_ready,
        "installed_models": status.installed_models,
    }


@router.post("/catalog")
def get_remote_model_catalog(payload: ModelCatalogRequest, request: Request) -> dict:
    settings = request.app.state.container.settings
    result = DiagnosticsService(settings).list_remote_models(
        provider=payload.provider,
        api_base_url=payload.api_base_url,
        api_key=payload.api_key,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "暂时无法读取模型列表")
    return result
