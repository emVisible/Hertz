"""运行控制：status/steps/run/chain/cancel/SSE 事件流。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_run.router 由 pipeline 聚合 include）。
"""

import json

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from backend.factory.registry import ServiceRegistry

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


@router.post("/run")
async def run_step(
    step: str,
    limit: int = Query(10, ge=1, le=50),
    channel: str = "",
    unscored: int = Query(0),
):
    """批量运行。v0.11.10：unscored=1 且 step=download 时拉取未评分条目
    直接下载（绕过评分，省 API 用量）；对其他步骤无效果。"""
    try:
        if step == "download" and unscored:
            return await _pipe().download_unscored(limit=limit)
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
