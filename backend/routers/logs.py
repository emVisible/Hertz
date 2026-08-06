"""Log endpoints: recent buffered lines for the web UI."""

from fastapi import APIRouter, Query

from backend.infrastructure.logging import log_manager

router = APIRouter(tags=["logs"])


@router.get("/logs/buffer")
async def logs_buffer(limit: int = Query(200, ge=1, le=2000)) -> dict:
    lines = log_manager.buffer.tail(limit)
    return {"lines": lines, "count": len(lines)}
