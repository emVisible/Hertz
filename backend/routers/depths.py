"""深度档位 REST endpoints（v0.3.10）：输出深度库（并列于 buff/debuff）。"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/depths", tags=["depths"])


def _service():
    return ServiceRegistry.get().depths


class DepthBody(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern="^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=120)
    effect: str = Field(default="", max_length=10_000)


class DepthUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    effect: str | None = Field(default=None, max_length=10_000)
    enabled: bool | None = None


@router.get("")
async def list_depths() -> list[dict]:
    return await _service().list_levels()


@router.post("")
async def create_depth(body: DepthBody) -> dict:
    try:
        return await _service().create(
            key=body.key, name=body.name, effect=body.effect
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{depth_id}")
async def update_depth(depth_id: uuid.UUID, body: DepthUpdate) -> dict:
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _service().update(depth_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{depth_id}")
async def delete_depth(depth_id: uuid.UUID) -> dict:
    try:
        await _service().delete(depth_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/restore-defaults")
async def restore_defaults() -> dict:
    return await _service().restore_defaults()
