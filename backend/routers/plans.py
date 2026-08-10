"""Plan REST endpoints (template CRUD + run trigger)."""

import uuid

from fastapi import APIRouter, HTTPException

from backend.factory.registry import ServiceRegistry
from backend.orchestration.errors import OrchestrationError
from backend.orchestration.phases import DEFAULT_PHASE_ORDER
from backend.routers.schemas import PlanBody, PlanUpdate, RunBody

router = APIRouter(prefix="/plans", tags=["plans"])


def _service():
    return ServiceRegistry.get().plans


def _studio():
    return ServiceRegistry.get().studio


@router.get("/defaults")
async def default_phase_order():
    return DEFAULT_PHASE_ORDER


@router.get("")
async def list_plans(limit: int = 100):
    return await _service().list(limit)


@router.post("")
async def create_plan(body: PlanBody):
    try:
        return await _service().create(
            name=body.name.strip(),
            description=body.description,
            phase_order=body.phase_order,
            mode=body.mode,
            crew_id=_uuid_or_none(body.crew_id),
            brief_id=_uuid_or_none(body.brief_id),
            buff_keys=body.buff_keys,
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{plan_id}")
async def get_plan(plan_id: uuid.UUID):
    try:
        return await _service().get(plan_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{plan_id}")
async def update_plan(plan_id: uuid.UUID, body: PlanUpdate):
    fields: dict = {}
    for key in ("name", "description", "phase_order", "mode", "buff_keys"):
        if getattr(body, key, None) is not None:
            fields[key] = getattr(body, key)
    for key in ("crew_id", "brief_id"):
        value = getattr(body, key, None)
        if value is not None:
            fields[key] = _uuid_or_none(value)
    try:
        return await _service().update(plan_id, **fields)
    except OrchestrationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/{plan_id}")
async def delete_plan(plan_id: uuid.UUID):
    try:
        await _service().delete(plan_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/{plan_id}/run")
async def run_plan(plan_id: uuid.UUID, body: RunBody | None = None):
    try:
        return await _studio().start(
            plan_id,
            (body.input if body else "").strip(),
            buff_keys=(body.buff_keys if body else None),
            depth=(body.depth if body else "normal"),
        )
    except OrchestrationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _uuid_or_none(value) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid id: {value}") from exc
