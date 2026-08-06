"""Buff REST endpoints: Buff 库（v5.0）。"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/buffs", tags=["buffs"])

_KINDS = {"lightweight", "heavy"}
_CATEGORIES = {"stable", "random"}
_POLARITIES = {"buff", "debuff"}


def _service():
    return ServiceRegistry.get().buffs


class BuffBody(BaseModel):
    key: str = Field(min_length=1, max_length=64, pattern="^[a-z0-9_]+$")
    name: str = Field(min_length=1, max_length=120)
    kind: str = Field(default="lightweight", max_length=16)
    polarity: str = Field(default="buff", max_length=16)
    effect: str = Field(default="", max_length=10_000)
    category: str = Field(default="stable", max_length=16)


class BuffUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    kind: str | None = Field(default=None, max_length=16)
    polarity: str | None = Field(default=None, max_length=16)
    effect: str | None = Field(default=None, max_length=10_000)
    category: str | None = Field(default=None, max_length=16)
    enabled: bool | None = None


@router.get("")
async def list_buffs() -> list[dict]:
    return await _service().list_buffs()


@router.post("")
async def create_buff(body: BuffBody) -> dict:
    if body.kind not in _KINDS:
        raise HTTPException(status_code=422, detail=f"invalid kind: {body.kind}")
    if body.category not in _CATEGORIES:
        raise HTTPException(status_code=422, detail=f"invalid category: {body.category}")
    if body.polarity not in _POLARITIES:
        raise HTTPException(status_code=422, detail=f"invalid polarity: {body.polarity}")
    try:
        return await _service().create(
            key=body.key,
            name=body.name,
            kind=body.kind,
            polarity=body.polarity,
            effect=body.effect,
            category=body.category,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{buff_id}")
async def update_buff(buff_id: uuid.UUID, body: BuffUpdate) -> dict:
    if body.kind is not None and body.kind not in _KINDS:
        raise HTTPException(status_code=422, detail=f"invalid kind: {body.kind}")
    if body.category is not None and body.category not in _CATEGORIES:
        raise HTTPException(status_code=422, detail=f"invalid category: {body.category}")
    if body.polarity is not None and body.polarity not in _POLARITIES:
        raise HTTPException(status_code=422, detail=f"invalid polarity: {body.polarity}")
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _service().update(buff_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{buff_id}")
async def delete_buff(buff_id: uuid.UUID) -> dict:
    try:
        await _service().delete(buff_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
