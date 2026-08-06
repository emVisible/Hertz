"""Studio endpoints: run history, output files, live event stream (SSE)."""

import json
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.factory.registry import ServiceRegistry
from backend.orchestration.errors import OrchestrationError

router = APIRouter(prefix="/studio", tags=["studio"])


def _studio():
    return ServiceRegistry.get().studio


@router.get("/status")
async def status():
    studio = _studio()
    return {"running": studio.running, "run_id": studio.current_run_id()}


@router.get("/runs")
async def list_runs(limit: int = Query(20, ge=1, le=100)):
    return await _studio().list_runs(limit)


@router.get("/runs/{run_id}")
async def get_run(run_id: uuid.UUID):
    try:
        return await _studio().get_run(run_id)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: uuid.UUID):
    try:
        return await _studio().cancel()
    except OrchestrationError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/runs/{run_id}/files")
async def list_run_files(run_id: uuid.UUID):
    try:
        return {"files": await _studio().list_files(run_id)}
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/runs/{run_id}/files/{name:path}")
async def read_run_file(run_id: uuid.UUID, name: str):
    try:
        content, _ = await _studio().read_file(run_id, name)
    except OrchestrationError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if name.endswith(".md") or not name or name.endswith("/"):
        return PlainTextResponse(content.decode("utf-8", "replace") if content else "")
    return StreamingResponse(iter([content]), media_type="application/octet-stream")


@router.get("/events")
async def studio_events():
    """SSE stream of run events (phase_start / log / phase_done / run_done)."""
    hub = ServiceRegistry.get().events

    async def stream():
        async with hub.subscribe("studio") as queue:
            yield "retry: 3000\n\n"
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
