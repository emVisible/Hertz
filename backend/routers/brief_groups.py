"""策略组 REST endpoints（v0.7）：策略的集合（类比团队=角色集合）。"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/brief-groups", tags=["brief-groups"])


def _service():
    return ServiceRegistry.get().brief_groups


class GroupBody(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=20_000)
    brief_ids: list[str] = Field(default_factory=list)


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=20_000)
    brief_ids: list[str] | None = None


def _uuids(ids: list[str]) -> list[uuid.UUID]:
    out = []
    for raw in ids:
        try:
            out.append(uuid.UUID(str(raw)))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"invalid brief id: {raw}") from exc
    return out


@router.get("")
async def list_groups() -> list[dict]:
    return await _service().list_groups()


@router.get("/{group_id}")
async def get_group(group_id: uuid.UUID) -> dict:
    try:
        return await _service().get(group_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("")
async def create_group(body: GroupBody) -> dict:
    return await _service().create(
        name=body.name,
        description=body.description,
        brief_ids=_uuids(body.brief_ids),
    )


@router.put("/{group_id}")
async def update_group(group_id: uuid.UUID, body: GroupUpdate) -> dict:
    fields: dict = {}
    if body.name is not None:
        fields["name"] = body.name
    if body.description is not None:
        fields["description"] = body.description
    if body.brief_ids is not None:
        fields["brief_ids"] = _uuids(body.brief_ids)
    try:
        return await _service().update(group_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{group_id}")
async def delete_group(group_id: uuid.UUID) -> dict:
    try:
        await _service().delete(group_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
