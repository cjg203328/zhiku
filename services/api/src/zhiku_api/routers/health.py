from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health")
def get_health(request: Request) -> dict[str, str]:
    settings = request.app.state.container.settings
    return {
        "status": "ok",
        "service": settings.app_name,
        "version": settings.app_version,
    }
