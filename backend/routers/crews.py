"""Team REST endpoints（表名 crews，语义=团队 v4.0）：角色的集合。"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry
from backend.orchestration.errors import OrchestrationError
from backend.routers.schemas import MAX_DESC, MAX_NAME

router = APIRouter(prefix="/crews", tags=["crews"])


def _service():
    return ServiceRegistry.get().crews


class TeamBody(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    description: str = Field(default="", max_length=MAX_DESC)
    role_keys: list[str] = Field(default_factory=list, max_length=16)


class TeamUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    description: str | None = Field(default=None, max_length=MAX_DESC)
    role_keys: list[str] | None = Field(default=None, max_length=16)


@router.get("")
async def list_crews(limit: int = 100):
    return await _service().list(limit)


@router.post("")
async def create_crew(body: TeamBody):
    try:
        return await _service().create(
            name=body.name.strip(),
            description=body.description,
            role_keys=body.role_keys,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{crew_id}")
async def get_crew(crew_id: uuid.UUID):
    try:
        return await _service().get(crew_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{crew_id}")
async def update_crew(crew_id: uuid.UUID, body: TeamUpdate):
    fields = {}
    for key in ("name", "description"):
        value = getattr(body, key, None)
        if value is not None:
            fields[key] = value
    if body.role_keys is not None:
        fields["agents"] = body.role_keys
    try:
        return await _service().update(crew_id, fields)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{crew_id}")
async def delete_crew(crew_id: uuid.UUID):
    try:
        await _service().delete(crew_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
