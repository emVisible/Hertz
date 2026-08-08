"""PipelineService — execution-domain service facade.

Owns batch-run lifecycle (single-flight guard, background tasks), the item
review API and event wiring. The heavy lifting is delegated to StepEngine.
"""

import asyncio
import logging
import uuid
from datetime import datetime

from sqlalchemy import func, or_, select

from backend.infrastructure.events import EventHub
from backend.models.item import Item, ItemStatus
from backend.models.pipeline import SourceState
from backend.models.session import session_factory
from backend.models.system import JobRun
from backend.pipeline.engine import StepEngine
from backend.pipeline.errors import ItemNotFoundError

logger = logging.getLogger(__name__)


class PipelineService:
    def __init__(self, hub: EventHub, engine: StepEngine) -> None:
        self.hub = hub
        self.engine = engine
        self._task: asyncio.Task | None = None
        self._current_job: str | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def current_job(self) -> str | None:
        return self._current_job

    # ---------- batch runs ----------

    async def run_batch(self, job_name: str, *, limit: int = 10, channel: str = "") -> dict:
        if self.running:
            raise RuntimeError(f"pipeline busy with job '{self._current_job}'")
        self._current_job = job_name
        try:
            self._task = asyncio.create_task(
                self.engine.run_batch(job_name, limit=limit, channel=channel),
                name=f"pipeline-{job_name}",
            )
            return await self._task
        finally:
            self._task = None
            self._current_job = None

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict:
        """collect → score → download → produce (stops at the review gate)."""
        if self.running:
            raise RuntimeError(f"pipeline busy with job '{self._current_job}'")
        self._current_job = "chain"
        try:
            self._task = asyncio.create_task(
                self.engine.run_chain(limit=limit, channel=channel),
                name="pipeline-chain",
            )
            return await self._task
        finally:
            self._task = None
            self._current_job = None

    async def cancel(self) -> dict:
        if self._task is None or self._task.done():
            raise RuntimeError("no pipeline job in progress")
        self._task.cancel()
        return {"ok": True, "cancelling": True}

    # ---------- review ----------

    async def approve(self, item_id: uuid.UUID) -> dict:
        return await self.engine.approve(item_id)

    async def reject(self, item_id: uuid.UUID, reason: str = "") -> dict:
        return await self.engine.reject(item_id, reason)

    async def retry(self, item_id: uuid.UUID) -> dict:
        return await self.engine.retry(item_id)

    async def requeue(self, item_id: uuid.UUID) -> dict:
        return await self.engine.requeue(item_id)

    # ---------- publish (独立人工环节，v5.10) ----------

    async def update_meta(
        self,
        item_id: uuid.UUID,
        *,
        bili_title: str | None = None,
        bili_tags: str | None = None,
        bili_tid: int | None = None,
        bili_copyright: int | None = None,
        scheduled_at: str | None = None,
    ) -> dict:
        """更新发布元数据（B站标题/标签/分区/版权/排期），单一真相源 script_json。"""
        from datetime import UTC, datetime

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            script = dict(item.script_json or {})
            if bili_title is not None:
                script["bili_title"] = bili_title.strip()
            if bili_tags is not None:
                script["bili_tags"] = bili_tags.strip()
            if bili_tid:
                script["bili_tid"] = int(bili_tid)
            elif bili_tid is not None:
                # 显式清空（0 = 回默认分区）
                script.pop("bili_tid", None)
            if bili_copyright is not None:
                script["bili_copyright"] = int(bili_copyright)
            item.script_json = script or None
            if scheduled_at is not None:
                raw = scheduled_at.strip()
                item.scheduled_at = (
                    datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(UTC)
                    if raw
                    else None
                )
            await session.merge(item)
            await session.commit()
        return {"id": str(item_id), "ok": True}

    async def publish_one(self, item_id: uuid.UUID, *, selfmade: bool = False) -> dict:
        """单条发布（审核通过后的人工操作）：执行 publisher 并落发布结果。

        定时由 item.scheduled_at 驱动（biliup --timedpublish）；自制由
        bili_copyright=1 驱动。target 仍来自 pipeline_publish_target（发布安全）。
        approved（首次发布）与 published（重新发布）均可。
        """
        from datetime import UTC, datetime

        from backend.pipeline.base import StepContext
        from backend.pipeline.errors import InvalidItemStateError
        from backend.pipeline.publishers.router import PUBLISHERS

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status not in (ItemStatus.APPROVED, ItemStatus.PUBLISHED):
                raise InvalidItemStateError(
                    f"cannot publish item in state {item.status}"
                )
            # phash 去重闸门（v0.2.1，参考原项目 block_publish_duplicates）：
            # 同源成片已被发布过 → 拒绝发布，避免重复投稿
            if item.phash:
                dup = (
                    await session.execute(
                        select(Item.id).where(
                            Item.phash == item.phash,
                            Item.status == ItemStatus.PUBLISHED,
                            Item.id != item.id,
                        )
                    )
                ).scalar_one_or_none()
                if dup is not None:
                    raise ValueError(
                        f"duplicate detected: phash {item.phash} already published "
                        f"(item {dup}) — 同源内容已发布，禁止重复投稿"
                    )
            if selfmade:
                script = dict(item.script_json or {})
                script["bili_copyright"] = 1
                item.script_json = script
            await session.commit()

        ctx = StepContext(
            run_id=str(item_id), settings=self.engine.settings, ai=None,
            emit=lambda e: self.hub.publish("pipeline", e),
        )
        target = getattr(self.engine.settings, "pipeline_publish_target", "noop")
        publisher = PUBLISHERS.get(target)
        if publisher is None:
            raise RuntimeError(f"unknown publish target '{target}'")
        result = await publisher.publish(ctx, item)

        async with session_factory() as session:
            row = await session.get(Item, item_id)
            row.status = ItemStatus.PUBLISHED
            row.publish_json = {"target": target, **result}
            row.published_at = datetime.now(UTC)
            await session.merge(row)
            await session.commit()
        self.hub.publish(
            "pipeline",
            {"type": "item", "item_id": str(item_id), "status": "published"},
        )
        return {"id": str(item_id), "status": "published", "result": result}

    # ---------- 自动过审（v0.2.1，参考原项目 auto_approve） ----------

    async def auto_approve(self) -> dict:
        """停留审核队列超过阈值的条目自动 approve（默认关闭，由配置开启）。"""
        from datetime import UTC, datetime, timedelta

        enabled = bool(getattr(self.engine.settings, "pipeline_auto_approve", False))
        if not enabled:
            return {"enabled": False, "approved": 0}
        hours = float(getattr(self.engine.settings, "pipeline_auto_approve_after_hours", 12))
        cutoff = datetime.now(UTC) - timedelta(hours=hours)
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.QUEUED,
                        Item.updated_at < cutoff,
                    )
                )
            ).scalars().all()
            for item in rows:
                item.status = ItemStatus.APPROVED
                item.approved_at = datetime.now(UTC)
                item.error = None
                self.hub.publish(
                    "pipeline",
                    {
                        "type": "item", "item_id": str(item.id),
                        "status": "approved", "step": "auto_approve",
                    },
                )
            await session.commit()
            return {"enabled": True, "approved": len(rows)}

    # ---------- queries ----------

    async def list_items(
        self, status: str | None = None, limit: int = 50, source: str | None = None
    ) -> list[dict]:
        """条目列表；status 支持逗号分隔多状态（wave13：前端单查询聚合阶段队列）。"""
        statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
        async with session_factory() as session:
            order = Item.created_at.desc()
            stmt = select(Item).order_by(order).limit(limit)
            conditions = []
            if statuses:
                conditions.append(Item.status.in_(statuses))
            if source:
                conditions.append(Item.source == source)
            if conditions:
                stmt = select(Item).where(*conditions).order_by(order).limit(limit)
            result = await session.execute(stmt)
            return [self._serialize(i) for i in result.scalars().all()]

    async def counts(self) -> dict[str, int]:
        async with session_factory() as session:
            result = await session.execute(select(Item.status, Item.id))
            counts: dict[str, int] = {}
            for status, _ in result:
                counts[status] = counts.get(status, 0) + 1
            return counts

    async def recent_jobs(self, limit: int = 20) -> list[dict]:
        async with session_factory() as session:
            result = await session.execute(
                select(JobRun).order_by(JobRun.started_at.desc()).limit(limit)
            )
            return [
                {
                    "id": str(j.id),
                    "job": j.job_name,
                    "status": j.status,
                    "summary": j.summary or {},
                    "error": j.error,
                    "started_at": j.started_at.isoformat() if j.started_at else None,
                    "finished_at": j.finished_at.isoformat() if j.finished_at else None,
                }
                for j in result.scalars().all()
            ]

    async def sources(self) -> list[dict]:
        """采集源健康度（v0.2.1，参考原项目三态）：dead / degraded / healthy。"""
        async with session_factory() as session:
            result = await session.execute(
                select(SourceState).order_by(SourceState.channel)
            )
            rows = result.scalars().all()
            out = []
            for s in rows:
                total = s.ok_count + s.fail_count
                if s.ok_count == 0 and s.fail_count > 0:
                    health = "dead"
                elif s.consecutive_fails >= 3 or (total > 0 and s.fail_count / total > 0.6):
                    health = "degraded"
                else:
                    health = "healthy"
                out.append({
                    "source": s.source,
                    "channel": s.channel,
                    "cursor": s.get_cursor(),
                    "ok_count": s.ok_count,
                    "fail_count": s.fail_count,
                    "consecutive_fails": s.consecutive_fails,
                    "last_error": s.last_error,
                    "last_error_at": s.last_error_at.isoformat() if s.last_error_at else None,
                    "last_run_at": s.last_run_at.isoformat() if s.last_run_at else None,
                    "health": health,
                })
            return out

    async def supply_warnings(self) -> list[str]:
        """供给告警（参考原项目漏斗水位）：空漏斗 / 供给偏紧 / 采集源失联。"""
        warnings: list[str] = []
        async with session_factory() as session:
            total_items = (
                await session.execute(select(func.count(Item.id)))
            ).scalar_one()
            if total_items == 0:
                warnings.append("funnel_empty")
                return warnings
            pre = (
                await session.execute(
                    select(func.count(Item.id)).where(
                        Item.status.in_(
                            (ItemStatus.DISCOVERED, ItemStatus.DOWNLOADED, ItemStatus.SCORED)
                        )
                    )
                )
            ).scalar_one()
            if pre < 5:
                warnings.append("supply_tight")
            sources = (
                await session.execute(
                    select(SourceState).where(SourceState.fail_count > 0)
                )
            ).scalars().all()
            if any(s.consecutive_fails >= 3 for s in sources):
                warnings.append("source_unreachable")
        return warnings

    # ---------- 内容日历（v0.2.3，参考 Buffer/新榜） ----------

    async def calendar_items(self, from_dt: datetime, to_dt: datetime) -> dict:
        """月视图聚合：区间内有排期/已发布日期的条目 + 未排期的待审/待发条目。

        日历不引入新表（AXIOM §1.2 单一真相源）——直接查现有
        scheduled_at / published_at / status 字段，前端负责渲染。
        未排期列表有界（200）：大库不整页拖垮（§7.4 列表与缓存）。
        """
        async with session_factory() as session:
            result = await session.execute(
                select(Item).where(
                    or_(
                        Item.scheduled_at.between(from_dt, to_dt),
                        Item.published_at.between(from_dt, to_dt),
                    )
                ).order_by(Item.scheduled_at.asc().nulls_last(), Item.created_at.desc())
            )
            items = [self._serialize(i) for i in result.scalars().all()]
            # 未排期待办：approved（待发布）与 queued（待审核）且无排期，最多 200 条
            unscheduled = (
                await session.execute(
                    select(Item).where(
                        Item.status.in_((ItemStatus.APPROVED, ItemStatus.QUEUED)),
                        Item.scheduled_at.is_(None),
                    ).order_by(Item.created_at.desc()).limit(200)
                )
            ).scalars().all()
        return {"items": items, "unscheduled": [self._serialize(i) for i in unscheduled]}

    # ---------- 失败分类看板（v0.2.1，参考原项目 Autarkeia） ----------

    async def failure_classes(self) -> dict[str, int]:
        """failed 条目按 error_class 聚合统计（空类 = 旧数据/未分类）。"""
        async with session_factory() as session:
            result = await session.execute(
                select(Item.error_class, Item.id).where(Item.status == ItemStatus.FAILED)
            )
            counts: dict[str, int] = {}
            for cls, _ in result:
                counts[cls or "other"] = counts.get(cls or "other", 0) + 1
            return counts

    async def retry_class(self, cls: str) -> int:
        """同类批量重试：把该失败分类的所有 failed 条目复位回可继续的状态。"""
        from backend.pipeline.errors import FAILURE_CLASSES

        if cls not in FAILURE_CLASSES:
            raise ValueError(f"unknown failure class '{cls}'")
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.FAILED,
                        Item.error_class == cls,
                    )
                )
            ).scalars().all()
            for item in rows:
                item.status = (
                    ItemStatus.SCORED
                    if item.video_path
                    else (ItemStatus.DOWNLOADED if item.raw_path else ItemStatus.DISCOVERED)
                )
                item.error = None
                item.error_class = ""
                item.retry_count += 1
            await session.commit()
            return len(rows)

    # ---------- 本地排期引擎（v0.2.1，参考原项目 scheduler_utils） ----------

    async def next_schedule_slot(self) -> str:
        """下一个发布槽位：窗口内 + 与已排期条目的最小间隔 + 抖动。"""
        from backend.pipeline.schedule import next_slot

        async with session_factory() as session:
            result = await session.execute(
                select(Item.scheduled_at).where(Item.scheduled_at.isnot(None))
            )
            existing = [t for t in result.scalars().all() if t is not None]
        return next_slot(
            existing,
            windows_raw=getattr(self.engine.settings, "pipeline_publish_windows", ""),
            min_interval_min=int(
                getattr(self.engine.settings, "pipeline_publish_min_interval_min", 30)
            ),
            jitter_min=int(getattr(self.engine.settings, "pipeline_publish_jitter_min", 5)),
            lookahead_days=int(
                getattr(self.engine.settings, "pipeline_publish_lookahead_days", 3)
            ),
        ).isoformat()

    @staticmethod
    def _serialize(item: Item) -> dict:
        return {
            "id": str(item.id),
            "status": item.status,
            "item_type": item.item_type,
            "source": item.source,
            "source_url": item.source_url,
            "media_url": item.media_url,
            "source_id": item.source_id,
            "title": item.title,
            "subreddit": item.subreddit,
            "author": item.author,
            "reddit_score": item.reddit_score,
            "upvote_ratio": item.upvote_ratio,
            "score_total": item.score_total,
            "score_dimensions": item.score_dimensions,
            "score_reasons": item.score_reasons or [],
            "is_lowscore": item.is_lowscore,
            "raw_path": item.raw_path,
            "video_path": item.video_path,
            "cover_path": item.cover_path,
            "script_json": item.script_json,
            "publish_json": item.publish_json,
            "error": item.error,
            "error_class": item.error_class,
            "retry_count": item.retry_count,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "approved_at": item.approved_at.isoformat() if item.approved_at else None,
            "scheduled_at": item.scheduled_at.isoformat() if item.scheduled_at else None,
            "published_at": item.published_at.isoformat() if item.published_at else None,
        }
