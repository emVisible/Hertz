"""Studio endpoints: run history, output files, live event stream (SSE)."""

import json
import logging
import uuid

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.factory.registry import ServiceRegistry
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.orchestration.errors import OrchestrationError

logger = logging.getLogger(__name__)

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


@router.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),  # noqa: B008 — FastAPI 依赖注入惯用,
) -> dict:
    """语音草稿转写（v0.24 脚本工坊）：音频 → faster-whisper 本地转写。

    返回分段文本（含时间戳），前端逐句编辑。不落库、不建条目——
    纯转换服务，调用方决定如何使用结果。
    """
    import asyncio
    import tempfile
    from pathlib import Path

    from backend.pipeline.producers.asr import whisper_available

    if not whisper_available():
        raise HTTPException(
            status_code=502,
            detail=(
                "本地转写引擎不可用（faster-whisper 未就绪）——开发态执行 uv sync "
                "安装依赖；打包版请查看 设置 → 流水线 能力矩阵的 Whisper 条目"
                "（模型未下载时可在该处一键下载）"
            ),
        )

    # 保存上传的音频到临时文件
    suffix = Path(file.filename or "audio.webm").suffix or ".webm"
    tmp = Path(tempfile.mkdtemp(prefix="hertz-transcribe-")) / f"input{suffix}"
    content = await file.read()
    if len(content) < 100:
        raise HTTPException(status_code=422, detail="音频文件过小或为空")
    await asyncio.to_thread(tmp.write_bytes, content)

    try:
        from backend.pipeline.producers.asr import transcribe_cues

        # 走 asr 的单一转写出口：与字幕产线共用时间轴断句口径 + 繁简纠偏。
        # 此前这里自己调了一次 whisper，导致工坊中文输出繁体（v0.32 S3）。
        cues = await transcribe_cues(tmp)
        segments = [
            {
                "start": round(float(t0), 2),
                "end": round(float(t1), 2),
                "text": str(text).strip(),
            }
            for t0, t1, text in cues
            if str(text).strip()
        ]
        full_text = " ".join(s["text"] for s in segments).strip()
        return {
            "segments": segments,
            "text": full_text,
            "duration_s": segments[-1]["end"] if segments else 0,
        }
    except HTTPException:
        raise
    except Exception as exc:
        if "not installed" in str(exc).lower() or "faster-whisper" in str(exc).lower():
            raise HTTPException(status_code=502, detail=f"转写失败: {exc}") from exc
        logger.exception("transcribe failed")
        raise HTTPException(status_code=500, detail="转写服务异常") from exc
    finally:
        await asyncio.to_thread(tmp.unlink, missing_ok=True)


@router.post("/draft-item")
async def create_draft_item(body: dict) -> dict:
    """脚本工坊 → 创建 text_only 条目（进入正常流水线）。

    接受用户编辑后的标题与正文，创建 text_only 条目，
    后续走评分→制作→审核标准流程。
    """
    import uuid as _uuid

    title = str(body.get("title") or "").strip()
    content = str(body.get("content") or "").strip()
    if not title or not content:
        raise HTTPException(status_code=422, detail="title 与 content 必填")

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.DISCOVERED,
            item_type="text_only",
            source="manual",
            source_id=f"manual-{_uuid.uuid4().hex[:12]}",
            source_url="",
            media_url=None,
            title=title[:300],
            subreddit="workshop",
            author="creator",
            reddit_score=0,
            upvote_ratio=1.0,
            num_comments=0,
            selftext=content,
        )
        session.add(item)
        await session.commit()
        await session.refresh(item)
        return {"id": str(item.id), "status": item.status}
