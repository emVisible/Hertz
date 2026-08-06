"""Download REST + SSE endpoints."""

import json
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from backend.download.errors import DownloadError
from backend.download.service import DownloadService
from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/download", tags=["download"])


def _service() -> DownloadService:
    return ServiceRegistry.get().download


@router.get("/parse")
async def parse_url(url: str = Query(...)):
    try:
        return await _service().describe(url)
    except DownloadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/tasks")
async def list_tasks(limit: int = Query(50, ge=1, le=200)):
    return await _service().list_tasks(limit)


@router.post("/tasks")
async def create_task(body: dict):
    url = body.get("url", "")
    project_id = body.get("project_id")
    title = body.get("title")
    try:
        if project_id:
            project_id = uuid.UUID(project_id)
        return await _service().create_task(url, project_id, title=title)
    except DownloadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/start")
async def start_task(task_id: uuid.UUID, body: dict | None = None):
    try:
        return await _service().start(task_id, body.get("format_id") if body else None)
    except DownloadError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: uuid.UUID):
    try:
        return await _service().cancel(task_id)
    except DownloadError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/tasks/{task_id}/retry")
async def retry_task(task_id: uuid.UUID):
    try:
        return await _service().retry(task_id)
    except DownloadError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: uuid.UUID):
    try:
        await _service().delete(task_id)
    except DownloadError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.get("/tasks/events")
async def task_events():
    """SSE stream of all download task events (progress / state changes)."""
    hub = ServiceRegistry.get().events

    async def stream():
        async with hub.subscribe("downloads") as queue:
            yield "retry: 3000\n\n"
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
