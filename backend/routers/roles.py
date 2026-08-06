"""Role REST endpoints: 角色库（v4.1 简化——纯 MD 内容实体）。"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry
from backend.routers.schemas import MAX_DESC

router = APIRouter(prefix="/roles", tags=["roles"])


def _service():
    return ServiceRegistry.get().roles


class RoleBody(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern="^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=120)
    role_name: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=MAX_DESC)


class RoleUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    role_name: str | None = Field(default=None, max_length=120)
    description: str | None = Field(default=None, max_length=MAX_DESC)
    enabled: bool | None = None


@router.get("")
async def list_roles() -> list[dict]:
    return await _service().list_roles()


@router.post("")
async def create_role(body: RoleBody) -> dict:
    try:
        return await _service().create(
            key=body.key,
            name=body.name,
            role_name=body.role_name,
            description=body.description,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{role_id}")
async def get_role(role_id: uuid.UUID) -> dict:
    try:
        return await _service().get(role_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{role_id}")
async def update_role(role_id: uuid.UUID, body: RoleUpdate) -> dict:
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _service().update(role_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{role_id}")
async def delete_role(role_id: uuid.UUID) -> dict:
    try:
        await _service().delete(role_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
