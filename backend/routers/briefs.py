"""Brief REST endpoints."""

import uuid

from fastapi import APIRouter, HTTPException

from backend.factory.registry import ServiceRegistry
from backend.orchestration.errors import OrchestrationError
from backend.routers.schemas import BriefBody, BriefUpdate

router = APIRouter(prefix="/briefs", tags=["briefs"])


def _service():
    return ServiceRegistry.get().briefs


@router.get("")
async def list_briefs(limit: int = 100):
    return await _service().list(limit)


@router.post("")
async def create_brief(body: BriefBody):
    try:
        return await _service().create(
            name=body.name.strip(),
            content=body.content,
            platform_id=body.platform_id,
            config_json=body.config,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{brief_id}")
async def get_brief(brief_id: uuid.UUID):
    try:
        return await _service().get(brief_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{brief_id}")
async def update_brief(brief_id: uuid.UUID, body: BriefUpdate):
    fields: dict = {}
    for key in ("name", "content", "platform_id"):
        value = getattr(body, key, None)
        if value is not None:
            fields[key] = value
    if body.config is not None:
        fields["config_json"] = body.config
    try:
        return await _service().update(brief_id, **fields)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{brief_id}")
async def delete_brief(brief_id: uuid.UUID):
    try:
        await _service().delete(brief_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}
