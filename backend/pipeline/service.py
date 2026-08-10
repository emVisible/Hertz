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


def _auto_tid(item) -> int | None:
    """分区自动建议：subreddit/关键词 → tid（参考原项目 assign_bili_tid）。"""
    try:
        from backend.pipeline.category import assign_bili_tid

        return assign_bili_tid(item.subreddit or "", item.item_type or "video_raw")
    except Exception:  # noqa: BLE001 — 建议失败不影响序列化
        return None


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
            # 同源成片已被发布过 → 拒绝发布，避免重复投稿。
            # v0.3.0：汉明距离 ≤5 容差（抽帧抖动/编码差异下同视频 phash 可翻转几位）
            if item.phash:
                from backend.pipeline.dedupe import find_phash_duplicate

                if await find_phash_duplicate(item.phash, exclude_id=item.id):
                    raise ValueError(
                        f"duplicate detected: phash {item.phash} already published "
                        f"(近源成片已发布，禁止重复投稿)"
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

    # ---------- 生产方式（v0.3.3，预处理人工选择） ----------

    PRODUCE_MODULES = ("passthrough", "voice", "subtitle", "translate", "mute")

    @staticmethod
    def normalize_produce_options(raw: dict) -> dict:
        """模块集合归一化：只保留合法模块布尔；直发与其他互斥（直发优先）。"""
        options = {
            m: bool(raw.get(m)) for m in PipelineService.PRODUCE_MODULES
        }
        if options["passthrough"]:
            for m in ("voice", "subtitle", "translate", "mute"):
                if m != "passthrough":
                    options[m] = False
        # 翻译依赖字幕：选翻译自动附带字幕
        if options["translate"]:
            options["subtitle"] = True
        return options

    async def set_produce_options(self, item_ids: list[uuid.UUID], raw: dict) -> int:
        """设置生产方式（单条或批量）：互斥校验 + 翻译附带字幕。"""
        options = self.normalize_produce_options(raw)
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item).where(Item.id.in_(item_ids))
                )
            ).scalars().all()
            for row in rows:
                row.produce_options = options
            await session.commit()
            return len(rows)

    # ---------- 重新处理 / 重新翻译（v0.2.7，参考原项目 reproduce/retranslate） ----------

    async def reprocess(self, item_id: uuid.UUID, *, retranslate: bool = False) -> dict:
        """打回重新生产（完成后回到审核队列）。

        reprocess（重新处理）：清空脚本与产物 → 完整重跑 script→TTS→字幕→合成；
        retranslate（重新翻译）：保留脚本，只重跑 TTS/字幕/合成（原视频上重翻译）。
        """
        from backend.pipeline.errors import InvalidItemStateError

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status not in (ItemStatus.QUEUED, ItemStatus.APPROVED, ItemStatus.FAILED):
                raise InvalidItemStateError(
                    f"cannot reprocess item in state {item.status}"
                )
            item.status = ItemStatus.SCORED  # produce 步骤消费 scored
            item.error = None
            if not retranslate:
                item.script_json = None  # 重新生成脚本
            for field in ("video_path", "cover_path", "audio_path", "subtitle_path", "phash"):
                setattr(item, field, None)
            await session.merge(item)
            await session.commit()
        self.hub.publish(
            "pipeline",
            {"type": "item", "item_id": str(item_id), "status": "scored",
             "step": "retranslate" if retranslate else "reprocess"},
        )
        return {"id": str(item_id), "status": "scored", "retranslate": retranslate}

    # ---------- 排期自动维护（v0.2.7） ----------

    async def reschedule_expired(self) -> int:
        """进入审核时调用：过期排期自动更新 + 未排期条目自动分配推荐槽位。

        - 过期（scheduled_at < now）→ next_slot 重新分配（不能排到过去）
        - 未排期的 queued/approved → 自动分配推荐槽位（每次进入系统都有排期，
          用户可再改）；单次最多 30 条，避免排期冲到遥远未来（§7.4 有界）
        """
        from datetime import UTC, datetime

        from backend.pipeline.schedule import next_slot

        now = datetime.now(UTC)
        async with session_factory() as session:
            pending = (
                await session.execute(
                    select(Item).where(
                        Item.status.in_((ItemStatus.QUEUED, ItemStatus.APPROVED)),
                    ).order_by(Item.created_at.desc())
                )
            ).scalars().all()
            expired = [i for i in pending if i.scheduled_at is not None and i.scheduled_at < now]
            unscheduled = [
                i for i in pending if i.scheduled_at is None
            ][:30]
            if not expired and not unscheduled:
                return 0
            allocated = [
                t for t in
                (await session.execute(
                    select(Item.scheduled_at).where(
                        Item.status.in_((ItemStatus.QUEUED, ItemStatus.APPROVED)),
                        Item.scheduled_at.isnot(None),
                        Item.scheduled_at >= now,
                    )
                )).scalars().all()
                if t is not None
            ]
            targets = expired + unscheduled
            for item in targets:
                slot = next_slot(
                    allocated,
                    now=now,
                    windows_raw=getattr(self.engine.settings, "pipeline_publish_windows", ""),
                    min_interval_min=int(
                        getattr(self.engine.settings, "pipeline_publish_min_interval_min", 30)
                    ),
                    jitter_min=0,  # 批量分配不做随机抖动，避免重复
                    lookahead_days=int(
                        getattr(self.engine.settings, "pipeline_publish_lookahead_days", 3)
                    ),
                )
                item.scheduled_at = slot
                allocated.append(slot)
            await session.commit()
            return len(targets)

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
        """条目列表；status 支持逗号分隔多状态（wave13：前端单查询聚合阶段队列）。
        排序：入库序号 seq desc（v0.3.1——同批 created_at 相同，seq 才是真实先后）。"""
        statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
        async with session_factory() as session:
            order = Item.seq.desc().nulls_last()
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
            "seq": item.seq,
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
            "produce_options": item.produce_options,
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
            # 分区自动建议（v0.2.7，参考原项目 assign_bili_tid）：未手动设置时的推荐分区
            "auto_tid": (
                None
                if (item.script_json or {}).get("bili_tid")
                else _auto_tid(item)
            ),
            "published_at": item.published_at.isoformat() if item.published_at else None,
        }
