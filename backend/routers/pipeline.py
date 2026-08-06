"""Pipeline endpoints: item review board, batch runs, live event stream."""

import json
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from backend.factory.registry import ServiceRegistry
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline


@router.get("/status")
async def status():
    pipe = _pipe()
    return {"running": pipe.running, "job": pipe.current_job()}


@router.get("/steps")
async def steps():
    from backend.pipeline.steps import step_keys

    return {"steps": step_keys()}


@router.get("/items")
async def list_items(
    status: str | None = None,
    limit: int = Query(50, ge=1, le=500),
    source: str | None = None,
):
    return await _pipe().list_items(status=status, limit=limit, source=source)


@router.get("/items/counts")
async def counts():
    return await _pipe().counts()


@router.post("/items/{item_id}/approve")
async def approve_item(item_id: uuid.UUID):
    try:
        return await _pipe().approve(item_id)
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidItemStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/items/{item_id}/reject")
async def reject_item(item_id: uuid.UUID, reason: str = ""):
    try:
        return await _pipe().reject(item_id, reason)
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidItemStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/items/{item_id}/retry")
async def retry_item(item_id: uuid.UUID):
    try:
        return await _pipe().retry(item_id)
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidItemStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/run")
async def run_step(
    step: str,
    limit: int = Query(10, ge=1, le=50),
    channel: str = "",
):
    try:
        return await _pipe().run_batch(step, limit=limit, channel=channel)
    except KeyError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/chain")
async def run_chain(
    limit: int = Query(10, ge=1, le=50),
    channel: str = "",
):
    try:
        return await _pipe().run_chain(limit=limit, channel=channel)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/cancel")
async def cancel():
    try:
        return await _pipe().cancel()
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/jobs")
async def recent_jobs(limit: int = Query(20, ge=1, le=100)):
    return await _pipe().recent_jobs(limit)


@router.get("/sources")
async def sources():
    return await _pipe().sources()


@router.get("/events")
async def pipeline_events():
    """SSE stream of pipeline events (log / job_step / item / job_done)."""
    hub = ServiceRegistry.get().events

    async def stream():
        async with hub.subscribe("pipeline") as queue:
            yield "retry: 3000\n\n"
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
