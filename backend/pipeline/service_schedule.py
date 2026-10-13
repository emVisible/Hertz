"""排期与过审域（v0.22.x 自 PublishMixin 迁出）：过期重排/自动过审/内容日历/槽位推荐。"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


class ScheduleMixin:
    async def reschedule_expired(self) -> int:
        """进入审核时调用：过期排期自动更新 + 未排期条目自动分配推荐槽位。

        - 过期（scheduled_at < now）→ next_slot 重新分配（不能排到过去）
        - 未排期的 queued/approved → 自动分配推荐槽位（每次进入系统都有排期，
          用户可再改）；单次最多 30 条，避免排期冲到遥远未来（§7.4 有界）
        """
        from datetime import datetime

        from backend.pipeline.publish_queue import PHASE_HOLDING
        from backend.pipeline.schedule import _lookahead_days, next_slot

        now = datetime.now(UTC)
        async with session_factory() as session:
            pending = (
                await session.execute(
                    select(Item).where(
                        Item.status.in_((ItemStatus.QUEUED, ItemStatus.APPROVED)),
                        # v0.12：预发布队列不自动分槽（排期由转正/用户决定）
                        Item.queue_phase != PHASE_HOLDING,
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
                        Item.queue_phase != PHASE_HOLDING,
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
                    lookahead_days=_lookahead_days(self.engine.settings),
                )
                if slot is None:
                    # 窗口排满/跨天无可用槽位 → 保持无排期（用户手动设），
                    # 绝不推延到 n 天后（v0.2.0 修复：此前连续分配排到 12 天后）
                    if item.scheduled_at is not None:
                        item.scheduled_at = None
                    continue
                item.scheduled_at = slot
                allocated.append(slot)
            await session.commit()
            return len(targets)

    # ---------- 自动过审（v0.2.1，参考原项目 auto_approve） ----------

    async def auto_approve(self) -> dict:
        """停留审核队列超过阈值的条目自动 approve（默认关闭，由配置开启）。"""
        from datetime import datetime

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
                    Item.archived.is_(False),
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
                        Item.archived.is_(False),
                        Item.status.in_((ItemStatus.APPROVED, ItemStatus.QUEUED)),
                        Item.scheduled_at.is_(None),
                    ).order_by(Item.created_at.desc()).limit(200)
                )
            ).scalars().all()
        return {"items": items, "unscheduled": [self._serialize(i) for i in unscheduled]}

    # ---------- 本地排期引擎（v0.2.1，参考原项目 scheduler_utils） ----------

    async def next_schedule_slot(self) -> str:
        """下一个发布槽位：窗口内 + 与已排期条目的最小间隔 + 抖动。
        v0.11.5：只统计未发布条目（queued/approved/downloaded）的排期——
        published/failed/rejected 的历史排期不参与挤压（否则推荐被推到几天后）。"""
        from backend.pipeline.schedule import _lookahead_days, next_slot

        async with session_factory() as session:
            result = await session.execute(
                select(Item.scheduled_at).where(
                    Item.scheduled_at.isnot(None),
                    Item.status.in_((
                        ItemStatus.QUEUED, ItemStatus.APPROVED, ItemStatus.DOWNLOADED,
                    )),
                )
            )
            existing = [t for t in result.scalars().all() if t is not None]
        slot = next_slot(
            existing,
            windows_raw=getattr(self.engine.settings, "pipeline_publish_windows", ""),
            min_interval_min=int(
                getattr(self.engine.settings, "pipeline_publish_min_interval_min", 30)
            ),
            jitter_min=int(getattr(self.engine.settings, "pipeline_publish_jitter_min", 5)),
            lookahead_days=_lookahead_days(self.engine.settings),
        )
        # 当天无可用槽位 → 返回空（前端回退 now+5min 兜底）
        return slot.isoformat() if slot else ""

