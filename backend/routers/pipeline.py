"""Pipeline endpoints: item review board, batch runs, live event stream."""

import json
import shutil
import uuid

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.config import settings
from backend.errors import HertzError
from backend.factory.registry import ServiceRegistry
from backend.pipeline.publishers.router import PUBLISHERS

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


@router.get("/trends")
async def trends(days: int = Query(30, ge=7, le=90)):
    """看板趋势（v0.5 B）：采集/入库/发布 按天聚合。"""
    return await _pipe().trends(days=days)


@router.get("/calendar")
async def calendar_items(
    from_: str = Query("", alias="from"),
    to: str = Query(""),
):
    """内容日历（v0.2.3）：区间内排期/已发布的条目 + 未排期待办。

    from/to 为 YYYY-MM-DD（本地日期语义，含端点整天）；缺省 to = from 所在月。
    """
    from datetime import UTC, datetime, timedelta

    def _local_day(raw: str) -> datetime:
        # 本地日期 → 本地零点（naive）；再统一转 UTC 与 scheduled_at 落库同语义。
        # 非法日期 → 422（§8.1 输入校验，不落 500）
        try:
            parsed = datetime.fromisoformat(raw.strip())
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"invalid date: {raw}") from exc
        return parsed

    if from_.strip():
        start_local = _local_day(from_)
    else:
        start_local = datetime.now()
    if to.strip():
        # 含 to 当天整天：end = to 次日零点 - 1us
        end_local = _local_day(to) + timedelta(days=1) - timedelta(microseconds=1)
    else:
        # 缺省 to → from 所在月（默认视图 = 当月日历）
        first = start_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        end_local = (first + timedelta(days=32)).replace(day=1) - timedelta(microseconds=1)
    return await _pipe().calendar_items(
        start_local.astimezone(UTC), end_local.astimezone(UTC)
    )


@router.post("/items/{item_id}/approve")
async def approve_item(item_id: uuid.UUID):
    return await _pipe().approve(item_id)


@router.post("/items/{item_id}/reject")
async def reject_item(item_id: uuid.UUID, reason: str = ""):
    return await _pipe().reject(item_id, reason)


@router.post("/items/{item_id}/retry")
async def retry_item(item_id: uuid.UUID):
    return await _pipe().retry(item_id)


@router.post("/items/{item_id}/score")
async def score_item(item_id: uuid.UUID):
    """单条评分（v0.3.5，预处理手动评分按钮）：仅已下载条目。"""
    try:
        return await _pipe().score_one(item_id)
    except HertzError:
        raise  # 领域错误（404/409）由全局 handler 映射
    except RuntimeError as exc:
        # 评分执行失败（LLM 等）→ 502
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/items/{item_id}/produce")
async def produce_item(item_id: uuid.UUID):
    """单条制作（v0.3.4，预处理「制作」按钮）：按生产方式立即执行 produce。"""
    try:
        return await _pipe().produce_one(item_id)
    except HertzError:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/items/{item_id}/requeue")
async def requeue_item(item_id: uuid.UUID):
    return await _pipe().requeue(item_id)


class BatchBody(BaseModel):
    action: str
    ids: list[uuid.UUID]


@router.post("/items/batch")
async def batch_items(body: BatchBody):
    """批量审核操作（v0.4 A2）：approve/reject/back_to_prep/back_to_collect/requeue。
    逐条执行，失败条目标记不中断；空列表直接返回 0。"""
    if not body.ids:
        return {"ok": 0, "failed": []}
    try:
        return await _pipe().batch_action(body.action, body.ids)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ---------- 生产方式预设模板（v0.4 B3） ----------


def _templates():
    from backend.pipeline.templates import ProduceTemplateService

    return ProduceTemplateService()


class TemplateBody(BaseModel):
    name: str
    options: dict


class TemplateUpdate(BaseModel):
    name: str | None = None
    options: dict | None = None


@router.get("/produce-templates")
async def list_produce_templates() -> list[dict]:
    return await _templates().list_templates()


@router.post("/produce-templates")
async def create_produce_template(body: TemplateBody) -> dict:
    try:
        return await _templates().create(name=body.name, options=body.options)
    except Exception as exc:  # noqa: BLE001 — 模板名冲突等返回可读错误
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/produce-templates/{template_id}")
async def update_produce_template(template_id: uuid.UUID, body: TemplateUpdate) -> dict:
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _templates().update(template_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/produce-templates/{template_id}")
async def delete_produce_template(template_id: uuid.UUID) -> dict:
    try:
        await _templates().delete(template_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


class PublishStatsBody(BaseModel):
    view: int = 0
    like: int = 0
    favorite: int = 0
    comment: int = 0
    share: int = 0


@router.post("/items/{item_id}/publish-stats")
async def set_publish_stats(item_id: uuid.UUID, body: PublishStatsBody) -> dict:
    """手动补录发布数据（v0.4 C1：自动回捞失败时的降级入口）。"""
    return await _pipe().set_publish_stats(item_id, body.model_dump())


@router.post("/items/{item_id}/back-to-prep")
async def back_to_prep(item_id: uuid.UUID):
    """审核打回预处理（v0.3.9 相邻双向）：queued → scored。"""
    return await _pipe().back_to_prep(item_id)


@router.post("/items/{item_id}/back-to-collect")
async def back_to_collect(item_id: uuid.UUID):
    """预处理打回采集（v0.3.9 相邻双向）：downloaded/scored → discovered。"""
    return await _pipe().back_to_collect(item_id)


@router.post("/reschedule-expired")
async def reschedule_expired():
    """过期排期自动重排（v0.2.7）：进入审核时调用，逐个分配不冲突的新槽位。"""
    return {"updated": await _pipe().reschedule_expired()}


class ProduceOptionsBody(BaseModel):
    ids: list[uuid.UUID]
    options: dict[str, bool]


@router.post("/produce-options")
async def set_produce_options(body: ProduceOptionsBody):
    """生产方式批量设置（v0.3.3，预处理人工选择）：
    直发与其他模块互斥；翻译自动附带字幕。"""
    if not body.ids:
        raise HTTPException(status_code=422, detail="ids 必填")
    if len(body.ids) > 200:
        raise HTTPException(status_code=422, detail="单批最多 200 条")
    try:
        updated = await _pipe().set_produce_options(body.ids, body.options)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"updated": updated}


class ItemMetaBody(BaseModel):
    bili_title: str | None = None
    bili_tags: str | None = None
    bili_tid: int | None = None
    bili_copyright: int | None = None
    scheduled_at: str | None = None


@router.put("/items/{item_id}/meta")
async def update_item_meta(item_id: uuid.UUID, body: ItemMetaBody):
    return await _pipe().update_meta(
        item_id,
        bili_title=body.bili_title,
        bili_tags=body.bili_tags,
        bili_tid=body.bili_tid,
        bili_copyright=body.bili_copyright,
        scheduled_at=body.scheduled_at,
    )


@router.post("/items/{item_id}/publish")
async def publish_item(item_id: uuid.UUID, selfmade: int = 0, target: str = ""):
    """发布：404/409 由全局 handler 映射；执行失败（缺 cookie/文件等）→ 502。"""
    try:
        return await _pipe().publish_one(
            item_id, selfmade=bool(selfmade), target=target.strip() or None
        )
    except HertzError:
        raise
    except Exception as exc:  # noqa: BLE001 — 发布失败返回可读错误
        raise HTTPException(status_code=502, detail=f"发布失败：{exc}") from exc


@router.get("/publish/status")
async def publish_status() -> dict:
    """发布健康状态（v0.3.8）：生效目标 + B 站 cookie 就绪度 + biliup 可用性。"""
    from pathlib import Path

    target = getattr(settings, "pipeline_publish_target", "noop")
    cookie_path = Path(settings.data_dir) / "bilibili.cookie"
    try:
        cookie_exists = cookie_path.exists()
        cookie_age_s = (
            int(__import__("time").time() - cookie_path.stat().st_mtime)
            if cookie_exists
            else None
        )
    except Exception:  # noqa: BLE001 — 状态检查 best-effort
        cookie_exists, cookie_age_s = False, None
    biliup = shutil.which("biliup") is not None
    return {
        "target": target,
        "biliup_available": biliup,
        "cookie_exists": cookie_exists,
        "cookie_path": str(cookie_path),
        "cookie_age_s": cookie_age_s,
        "publishers": list(PUBLISHERS),
        # noop 目标下发布只是记录意图——前端据此刻意警示
        "noop": target == "noop",
    }


@router.post("/items/{item_id}/cover")
async def upload_cover(item_id: uuid.UUID, file: UploadFile = File(...)):  # noqa: B008 — FastAPI 依赖注入惯用
    """上传并替换审核条目的封面（v0.2.6）：保存到 data/media/covers/，更新 cover_path。"""
    from backend.factory.registry import ServiceRegistry
    from backend.models.item import Item
    from backend.models.session import session_factory

    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    if ext not in ("jpg", "jpeg", "png", "webp"):
        raise HTTPException(status_code=422, detail="仅支持 jpg/png/webp 封面")
    files = ServiceRegistry.get().files
    dest = files.resolve(f"media/covers/{item_id}.{ext}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=422, detail="封面文件过大（≤10MB）")
    await files.atomic_write(dest, content)
    async with session_factory() as session:
        item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        item.cover_path = str(dest)
        await session.merge(item)
        await session.commit()
    return {"id": str(item_id), "cover_path": str(dest)}


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
