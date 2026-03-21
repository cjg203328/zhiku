from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from ..repositories import LibraryRepository

router = APIRouter(prefix="/api/v1/collections", tags=["collections"])


class CollectionCreateRequest(BaseModel):
    name: str
    description: str = ""
    color: str = "#4f8ef7"
    icon: str = "◫"


class CollectionUpdateRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None
    icon: str | None = None


class AssignCollectionRequest(BaseModel):
    collection_id: str | None = None


@router.get("")
def list_collections(request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    items = repository.list_collections()
    return {"items": items, "total": len(items)}


@router.post("")
def create_collection(payload: CollectionCreateRequest, request: Request) -> dict:
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="分组名称不能为空")
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    return repository.create_collection(
        name=payload.name.strip(),
        description=payload.description,
        color=payload.color,
        icon=payload.icon,
    )


@router.patch("/{collection_id}")
def update_collection(collection_id: str, payload: CollectionUpdateRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    updated = repository.update_collection(
        collection_id,
        name=payload.name,
        description=payload.description,
        color=payload.color,
        icon=payload.icon,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="分组不存在")
    return updated


@router.delete("/{collection_id}")
def delete_collection(collection_id: str, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    deleted = repository.delete_collection(collection_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="分组不存在")
    return {"deleted": True, "id": collection_id}


@router.post("/assign/{content_id}")
def assign_content_to_collection(content_id: str, payload: AssignCollectionRequest, request: Request) -> dict:
    repository = LibraryRepository(request.app.state.container.settings.db_path)
    ok = repository.assign_content_collection(content_id, payload.collection_id)
    if not ok:
        raise HTTPException(status_code=404, detail="内容不存在")
    return {"ok": True, "content_id": content_id, "collection_id": payload.collection_id}
