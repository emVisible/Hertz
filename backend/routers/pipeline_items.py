"""条目域：列表/审核/预处理单条/批量/meta/封面/日历/趋势。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_items.router 由 pipeline 聚合 include）。
"""

import uuid
from datetime import datetime

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from backend.errors import HertzError
from backend.factory.registry import ServiceRegistry
from backend.pipeline.errors import ItemNotFoundError

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline

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


# ---------- Reddit Cookie（v0.8.1，参考原项目：OAuth 个人拿不到→登录 Cookie） ----------


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
    """单条评分（v0.3.5，预处理手动评分按钮）：v0.8.6 评分先行——仅未评分条目。"""
    try:
        return await _pipe().score_one(item_id)
    except HertzError:
        raise  # 领域错误（404/409）由全局 handler 映射
    except RuntimeError as exc:
        # 评分执行失败（LLM 等）→ 502
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/items/{item_id}/download")
async def download_item(item_id: uuid.UUID, skip_score: int = 0):
    """单条下载（v0.8.6 评分先行，预处理手动下载按钮）：仅已评分未下载条目。
    v0.11.10：skip_score=1 放行未评分条目——绕过评分直接下载（省 API 用量）。"""
    try:
        return await _pipe().download_one(item_id, skip_score=bool(skip_score))
    except HertzError:
        raise
    except RuntimeError as exc:
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


@router.post("/items/{item_id}/produce-cancel")
async def cancel_produce(item_id: uuid.UUID):
    """取消单条制作（wave11）：置位协作取消标志——产线检查点命中即中止，
    条目回滚 downloaded（不标失败）。幂等：条目未在制作也无害。"""
    return await _pipe().produce_cancel(item_id)


@router.post("/items/{item_id}/requeue")
async def requeue_item(item_id: uuid.UUID):
    return await _pipe().requeue(item_id)


class BatchBody(BaseModel):
    action: str
    ids: list[uuid.UUID] = Field(..., max_length=200)  # v0.8.8 AXIOM 8.1：防大查询/长事务


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


# ---------- 归档 / 备用库（wave10：删除入口收口异常区） ----------


class ArchiveBody(BaseModel):
    ids: list[uuid.UUID] = Field(..., max_length=200)  # AXIOM 8.1：防大查询/长事务


@router.get("/items/archived")
async def archived_items(limit: int = Query(200, ge=1, le=500)):
    """备用库：archived 条目列表（seq desc）。"""
    return await _pipe().archived_items(limit=limit)


@router.post("/items/archive")
async def archive_items(body: ArchiveBody):
    """批量归档：磁盘清理 + 字段清洗 + 标记 archived（数据保留作备用库）。"""
    return await _pipe().archive(body.ids)


@router.post("/items/unarchive")
async def unarchive_items(body: ArchiveBody):
    """批量恢复：清除 archived 标记（磁盘已删，重制重新生成）。"""
    return await _pipe().unarchive(body.ids)


@router.post("/items/purge")
async def purge_items(body: ArchiveBody):
    """批量彻底删除（不可逆）：仅归档条目，物理删行。"""
    return await _pipe().purge(body.ids)


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


@router.post("/items/{item_id}/back-to-prep")
async def back_to_prep(item_id: uuid.UUID):
    """审核打回预处理（v0.3.9 相邻双向）：queued → scored。"""
    return await _pipe().back_to_prep(item_id)


@router.post("/items/{item_id}/back-to-collect")
async def back_to_collect(item_id: uuid.UUID):
    """预处理打回采集（v0.3.9 相邻双向）：downloaded/scored → discovered。"""
    return await _pipe().back_to_collect(item_id)


@router.post("/items/{item_id}/retranslate")
async def retranslate(item_id: uuid.UUID):
    """重新翻译（v0.8.9，对齐原项目 retranslate_item）：提取视频原声 →
    逐段中文字幕（原声保留、无 TTS），ASR 失败回 502。"""
    return await _pipe().retranslate(item_id)


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


class PriorityBody(BaseModel):
    ordered_ids: list[uuid.UUID]


@router.post("/items/priority")
async def set_priority(body: PriorityBody):
    """制作优先级落库（v0.26 运营面板）：按给定顺序赋 priority，首位最高。
    engine 取件按 priority 降序——批量队列拖拽排序的持久化后端。"""
    if not body.ordered_ids:
        raise HTTPException(status_code=422, detail="ordered_ids 必填")
    if len(body.ordered_ids) > 200:
        raise HTTPException(status_code=422, detail="单批最多 200 条")
    try:
        return await _pipe().set_priority(body.ordered_ids)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


class ItemMetaBody(BaseModel):
    """发布元数据（v0.8.8 AXIOM 8.1：长度/范围上限 + 非法排期 422）。"""
    bili_title: str | None = Field(None, max_length=80)
    bili_desc: str | None = Field(None, max_length=500)
    bili_tags: str | None = Field(None, max_length=200)
    bili_tid: int | None = Field(None, ge=0, le=500)  # 0 = 清空回默认分区（service 层 pop）
    bili_copyright: int | None = Field(None, ge=1, le=2)
    scheduled_at: str | None = Field(None, max_length=40)


@router.put("/items/{item_id}/meta")
async def update_item_meta(item_id: uuid.UUID, body: ItemMetaBody):
    try:
        return await _pipe().update_meta(
            item_id,
            bili_title=body.bili_title,
            bili_tags=body.bili_tags,
            bili_desc=body.bili_desc,
            bili_tid=body.bili_tid,
            bili_copyright=body.bili_copyright,
            scheduled_at=body.scheduled_at,
        )
    except ValueError as exc:
        # 非法排期格式 → 422（此前落入全局 handler 返回 500，AXIOM 8.1/4.2）
        raise HTTPException(status_code=422, detail=str(exc)) from exc


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


@router.post("/items/{item_id}/cover-random")
async def random_cover(item_id: uuid.UUID):
    """随机抽帧封面（v0.11.5）：从成片/原片随机取一帧 → 1280x720 裁切 →
    覆盖 cover_path。点击一次换一帧（随机位置 5%-95%），updated_at 触发缩略图刷新。"""
    from backend.factory.registry import ServiceRegistry
    from backend.models.item import Item
    from backend.models.session import session_factory
    from backend.pipeline.producers.media import extract_random_cover

    async with session_factory() as session:
        item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        video = item.video_path or item.raw_path
        if not video:
            raise HTTPException(status_code=422, detail="条目没有可抽帧的视频")
        files = ServiceRegistry.get().files
        dest = files.resolve(f"media/covers/{item_id}-random.jpg")
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            await extract_random_cover(video, dest)
        except Exception as exc:  # noqa: BLE001 — 抽帧失败给出可读错误
            raise HTTPException(status_code=502, detail=f"抽帧失败：{exc}") from exc
        item.cover_path = str(dest)
        item.updated_at = datetime.now()  # 缩略图 URL 缓存版本（v0.8.9）
        await session.merge(item)
        await session.commit()
    return {"id": str(item_id), "cover_path": str(dest)}


