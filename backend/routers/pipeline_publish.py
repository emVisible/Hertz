"""发布域：publish/publish-status/发布数据回捞/发布队列。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_publish.router 由 pipeline 聚合 include）。
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from backend.config import settings
from backend.errors import HertzError
from backend.factory.registry import ServiceRegistry
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.publish_queue import QUEUE_PHASES
from backend.pipeline.publish_reliability import cooldown_left
from backend.pipeline.publishers.router import PUBLISHERS

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline

class PublishStatsBody(BaseModel):
    view: int = 0
    like: int = 0
    favorite: int = 0
    comment: int = 0
    share: int = 0


class QueueBody(BaseModel):
    phase: str = Field("", description="''=出队｜holding=预发布队列｜ready=发布队列")


class QueueBatchBody(BaseModel):
    ids: list[uuid.UUID] = Field(..., min_length=1, max_length=200)
    phase: str = ""


@router.get("/publish/queue")
async def publish_queue_view() -> dict:
    """发布队列看板（v0.12）：ready/holding 列表 + 今日产能进度。"""
    return await _pipe().queue_view()


@router.post("/items/batch/queue")
async def enqueue_batch(body: QueueBatchBody) -> dict:
    """批量入队（v0.12）：逐条执行，失败不中断。"""
    if body.phase not in QUEUE_PHASES:
        raise HTTPException(status_code=422, detail=f"unknown queue phase '{body.phase}'")
    return await _pipe().enqueue_batch(body.ids, body.phase)


@router.post("/items/{item_id}/queue")
async def enqueue_item(item_id: uuid.UUID, body: QueueBody) -> dict:
    """入队/出队（v0.12）：phase 校验失败 → 422；状态不允许 → 409；
    ready 无槽位 → 422（今天窗口已排满）。"""
    if body.phase not in QUEUE_PHASES:
        raise HTTPException(status_code=422, detail=f"unknown queue phase '{body.phase}'")
    try:
        return await _pipe().enqueue(item_id, body.phase)
    except HertzError:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/items/{item_id}/publish-stats")
async def set_publish_stats(item_id: uuid.UUID, body: PublishStatsBody) -> dict:
    """手动补录发布数据（v0.4 C1：自动回捞失败时的降级入口）。"""
    return await _pipe().set_publish_stats(item_id, body.model_dump())


@router.post("/items/{item_id}/publish")
async def publish_item(item_id: uuid.UUID, selfmade: int = 0, target: str = "", now: int = 0):
    """发布：404/409 由全局 handler 映射；执行失败（缺 cookie/文件等）→ 502。
    v0.11.5：now=1（立即发布）→ 清除 scheduled_at 按当前时间上传。"""
    try:
        return await _pipe().publish_one(
            item_id, selfmade=bool(selfmade), target=target.strip() or None, now=bool(now)
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
    cookie_path = Path(settings.data_dir) / "core" / "cookies.json"
    try:
        cookie_exists = cookie_path.exists()
        cookie_age_s = (
            int(__import__("time").time() - cookie_path.stat().st_mtime)
            if cookie_exists
            else None
        )
    except Exception:  # noqa: BLE001 — 状态检查 best-effort
        cookie_exists, cookie_age_s = False, None
    # v0.8.8：biliup 可用性读 deps 缓存（启动/设置页手动检测），不再每次轮询 which
    from backend.infrastructure.deps import dep_ok, load_dependencies

    biliup = dep_ok(load_dependencies(), "biliup")

    # v0.38：发布可靠性状态。
    #
    # 熔断与重试上一轮就做了，但**没有任何出口**——一个不可观测的状态等于不存在：
    # 用户看到「发布失败」，界面告诉他「失败」，却既不知道目标是不是正在被限流
    # 冻结，也看不出最近失败都归到哪一类。这两个数就是把那口黑箱打开的地方。
    cooldowns: dict[str, float] = {}
    for name in PUBLISHERS:
        try:
            left = await cooldown_left(name)
        except Exception:  # noqa: BLE001 — 状态查询 best-effort，不让它掀掉整个健康检查
            continue
        if left > 0:
            cooldowns[name] = round(left, 1)

    # 近 7 天发布失败的分类分布：回答「为什么发不出去」而不是只回答「失败了」
    since = datetime.now(UTC) - timedelta(days=7)
    async with session_factory() as session:
        failure_rows = (
            await session.execute(
                select(Item.error_class, func.count())
                .where(
                    Item.status == ItemStatus.FAILED,
                    Item.error_class != "",
                    Item.updated_at >= since,
                )
                .group_by(Item.error_class)
            )
        ).all()
    by_class = {cls or "other": int(n) for cls, n in failure_rows}

    return {
        "target": target,
        "biliup_available": biliup,
        "cookie_exists": cookie_exists,
        "cookie_path": str(cookie_path),
        "cookie_age_s": cookie_age_s,
        "publishers": list(PUBLISHERS),
        # noop 目标下发布只是记录意图——前端据此刻意警示
        "noop": target == "noop",
        # v0.38
        "max_attempts": int(getattr(settings, "pipeline_publish_max_attempts", 3)),
        "cooldowns_s": cooldowns,
        "target_throttled": target in cooldowns,
        "failures_7d_by_class": by_class,
    }


