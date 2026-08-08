"""Pipeline endpoints: item review board, batch runs, live event stream."""

import json
import uuid

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

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


@router.post("/items/{item_id}/requeue")
async def requeue_item(item_id: uuid.UUID):
    try:
        return await _pipe().requeue(item_id)
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidItemStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


class ItemMetaBody(BaseModel):
    bili_title: str | None = None
    bili_tags: str | None = None
    bili_tid: int | None = None
    bili_copyright: int | None = None
    scheduled_at: str | None = None


@router.put("/items/{item_id}/meta")
async def update_item_meta(item_id: uuid.UUID, body: ItemMetaBody):
    try:
        return await _pipe().update_meta(
            item_id,
            bili_title=body.bili_title,
            bili_tags=body.bili_tags,
            bili_tid=body.bili_tid,
            bili_copyright=body.bili_copyright,
            scheduled_at=body.scheduled_at,
        )
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/items/{item_id}/publish")
async def publish_item(item_id: uuid.UUID, selfmade: int = 0):
    try:
        return await _pipe().publish_one(item_id, selfmade=bool(selfmade))
    except ItemNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except InvalidItemStateError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — 发布失败（缺 cookie/文件等）返回可读错误
        raise HTTPException(status_code=502, detail=f"发布失败：{exc}") from exc


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


@router.get("/supply")
async def supply_warnings():
    """供给告警（漏斗空 / 供给偏紧 / 采集源失联）。"""
    return {"warnings": await _pipe().supply_warnings()}


@router.get("/failures")
async def failure_classes():
    """failed 条目按失败分类聚合（v0.2.1 失败分类看板）。"""
    return await _pipe().failure_classes()


class RetryClassBody(BaseModel):
    cls: str


@router.post("/retry-class")
async def retry_failure_class(body: RetryClassBody):
    """同类批量重试：该失败分类的所有 failed 条目复位回可继续状态。"""
    try:
        count = await _pipe().retry_class(body.cls)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"cls": body.cls, "requeued": count}


@router.get("/schedule/next")
async def next_schedule_slot():
    """下一个发布槽位（本地排期引擎）：窗口内 + 最小间隔 + 抖动。"""
    return {"recommended_at": await _pipe().next_schedule_slot()}


@router.post("/auto-approve")
async def auto_approve():
    """手动触发自动过审（配置 pipeline_auto_approve 开启才生效）。"""
    return await _pipe().auto_approve()


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
