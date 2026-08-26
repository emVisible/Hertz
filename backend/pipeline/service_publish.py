"""PipelineService 发布·队列·排期域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.models import script_keys as sk
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.base import StepContext
from backend.pipeline.errors import ItemNotFoundError

logger = logging.getLogger(__name__)


class PublishMixin:
    async def update_meta(
        self,
        item_id: uuid.UUID,
        *,
        bili_title: str | None = None,
        bili_desc: str | None = None,
        bili_tags: str | None = None,
        bili_tid: int | None = None,
        bili_copyright: int | None = None,
        scheduled_at: str | None = None,
    ) -> dict:
        """更新发布元数据（B站标题/简介/标签/分区/版权/排期），单一真相源 script_json。"""
        from datetime import UTC, datetime

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            script = dict(item.script_json or {})
            if bili_title is not None:
                script[sk.BILI_TITLE] = bili_title.strip()
            if bili_desc is not None:
                script[sk.BILI_DESC] = bili_desc.strip()
            if bili_tags is not None:
                script[sk.BILI_TAGS] = bili_tags.strip()
            if bili_tid:
                script[sk.BILI_TID] = int(bili_tid)
            elif bili_tid is not None:
                # 显式清空（0 = 回默认分区）
                script.pop(sk.BILI_TID, None)
            if bili_copyright is not None:
                script[sk.BILI_COPYRIGHT] = int(bili_copyright)
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

    async def publish_one(
        self, item_id: uuid.UUID, *,
        selfmade: bool = False, target: str | None = None, now: bool = False,
        auto: bool = False,
    ) -> dict:
        """单条发布（审核通过后的人工操作）：执行 publisher 并落发布结果。

        定时由 item.scheduled_at 驱动（biliup --dtime）；自制由
        bili_copyright=1 驱动。v0.3.4：target 逐条可覆盖（分发目标），
        缺省回退 pipeline_publish_target（发布安全）。
        v0.11.5：now=True（立即发布）→ 清除 scheduled_at，按当前时间立即上传。
        v0.12：auto=True（自动发布 tick 调用）→ publish_json 记 auto 标记，
        产能计数依据（手动发布不标记、不占产能）。
        approved（首次发布）与 published（重新发布）均可。
        """
        from datetime import UTC, datetime

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
                script[sk.BILI_COPYRIGHT] = 1
                item.script_json = script
            if now:
                # v0.11.5：立即发布 → 清空排期，publisher 不再带 --dtime
                item.scheduled_at = None
            await session.commit()

        ctx = StepContext(
            run_id=str(item_id), settings=self.engine.settings, ai=None,
            emit=lambda e: self.hub.publish("pipeline", e),
        )
        target = target or getattr(self.engine.settings, "pipeline_publish_target", "noop")
        publisher = PUBLISHERS.get(target)
        if publisher is None:
            raise RuntimeError(f"unknown publish target '{target}'")
        try:
            result = await publisher.publish(ctx, item)
        except Exception:
            # 告警（v0.22 A2）：真实发布（非 noop）失败推送 Telegram，best-effort
            if target != "noop":
                import asyncio

                from backend.integrations.telegram_bot import push_alert

                asyncio.ensure_future(push_alert(
                    f"🔴 发布失败 [{target}] {item.title[:60]}\n"
                    f"item: {item_id}"
                ))
            raise
        if target == "noop":
            # v0.3.8：noop 只记录意图——明确标注，前端醒目警示「未真正上传」
            result["noop"] = True

        async with session_factory() as session:
            row = await session.get(Item, item_id)
            row.status = ItemStatus.PUBLISHED
            pub_json: dict = {"target": target, **result}
            if auto:
                # v0.12 产能计数依据：仅自动发布标记，手动发布不计入每日上限
                pub_json["auto"] = True
            row.publish_json = pub_json
            row.published_at = datetime.now(UTC)
            # v0.9 对齐原项目 ensure_bilibili_dtime：biliup 顺延后回写
            # scheduled_at，排期日历与发布卡保持一致（单一真相源）
            bumped = result.get("dtime_bumped_to")
            if bumped:
                row.scheduled_at = datetime.fromtimestamp(int(bumped), UTC)
            await session.merge(row)
            await session.commit()
        self.hub.publish(
            "pipeline",
            {"type": "item", "item_id": str(item_id), "status": "published"},
        )
        return {
            "id": str(item_id),
            "status": "published",
            "result": result,
            # v0.3.8：noop 目标标记外提——前端直接判断，无需穿透 result
            "noop": bool(result.get("noop")),
        }

    async def enqueue(
        self, item_id: uuid.UUID, phase: str = ""
    ) -> dict:
        """入队/出队：''=出队（纯手动）｜holding=预发布｜ready=发布队列。

        仅 approved 状态可入队；ready 必须有排期（无排期自动分配当天窗口槽位，
        排满则拒绝）；holding 清除排期（语义：不参与排期与自动发布）。
        """
        from backend.pipeline.errors import InvalidItemStateError
        from backend.pipeline.publish_queue import (
            PHASE_HOLDING,
            PHASE_READY,
            QUEUE_PHASES,
        )

        if phase not in QUEUE_PHASES:
            raise ValueError(f"unknown queue phase '{phase}'")
        from backend.pipeline.schedule import next_slot

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.archived:
                raise InvalidItemStateError("cannot enqueue an archived item (备用库)")
            if phase:
                if item.status != ItemStatus.APPROVED:
                    raise InvalidItemStateError(
                        f"cannot enqueue item in state {item.status} (需审核通过)"
                    )
                if phase == PHASE_READY and item.scheduled_at is None:
                    from datetime import UTC, datetime

                    now = datetime.now(UTC)
                    allocated = [
                        t for t in
                        (
                            await session.execute(
                                select(Item.scheduled_at).where(
                                    Item.status == ItemStatus.APPROVED,
                                    Item.queue_phase == PHASE_READY,
                                    Item.scheduled_at.isnot(None),
                                    Item.scheduled_at >= now,
                                )
                            )
                        ).scalars().all()
                        if t is not None
                    ]
                    slot = next_slot(
                        allocated,
                        now=now,
                        windows_raw=getattr(self.engine.settings, "pipeline_publish_windows", ""),
                        min_interval_min=int(
                            getattr(self.engine.settings, "pipeline_publish_min_interval_min", 30)
                        ),
                        jitter_min=0,
                        lookahead_days=1,
                    )
                    if slot is None:
                        raise ValueError("今天发布窗口已排满，无法自动分配槽位（请先手动设置排期）")
                    item.scheduled_at = slot
                if phase == PHASE_HOLDING:
                    # holding 语义 = 无排期待命；清掉防止内容日历/自动发布误读
                    item.scheduled_at = None
            item.queue_phase = phase
            await session.commit()
        self.hub.publish(
            "pipeline",
            {
                "type": "item", "item_id": str(item_id),
                "status": item.status, "queue_phase": phase,
            },
        )
        return {"id": str(item_id), "queue_phase": phase, "scheduled_at": (
            item.scheduled_at.isoformat() if item.scheduled_at else None
        )}

    async def enqueue_batch(self, ids: list[uuid.UUID], phase: str) -> dict:
        """批量入队（v0.12）：逐条走 enqueue，单条失败不中断。"""
        from backend.pipeline.errors import InvalidItemStateError

        ok, failed = 0, []
        for item_id in ids:
            try:
                await self.enqueue(item_id, phase)
                ok += 1
            except (
                InvalidItemStateError,
                ItemNotFoundError,
                ValueError,
            ) as exc:
                failed.append({"id": str(item_id), "error": str(exc)})
        return {"ok": ok, "failed": failed}


    async def queue_view(self) -> dict:
        """发布队列看板：ready（按排期）+ holding（按入库序）+ 今日产能 +
        账号画像（v0.13 策略开启时）。"""
        from backend.pipeline.publish_queue import (
            PHASE_HOLDING,
            PHASE_READY,
            local_day_bounds,
        )
        from backend.pipeline.strategy import daily_quota

        now = datetime.now(UTC)
        day_start, _day_end = local_day_bounds(now)
        daily_limit = int(
            getattr(self.engine.settings, "pipeline_auto_publish_daily_limit", 5) or 5
        )
        async with session_factory() as session:
            ready = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_READY,
                        Item.archived.is_(False),
                    ).order_by(Item.scheduled_at.asc().nulls_last())
                )
            ).scalars().all()
            holding = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_HOLDING,
                        Item.archived.is_(False),
                    ).order_by(Item.seq.asc()).limit(200)
                )
            ).scalars().all()
            published_today = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.PUBLISHED,
                        Item.published_at >= day_start,
                        Item.archived.is_(False),
                    )
                )
            ).scalars().all()
        used = sum(
            1 for i in published_today if (i.publish_json or {}).get("auto")
        )
        # v0.13：策略开启 → 看板带账号画像（相位/配额/证据/近 7 日趋势）
        account = None
        cfg = self._strategy_cfg()
        if cfg.enabled:
            state = await self._current_account_state(now)
            quota = daily_quota(state, cfg=cfg)
            account = {
                "phase": state.phase,
                "quota": quota,
                "used": used,
                "reasons": list(state.reasons),
                "days": [
                    {"date": d.date, "uploads": d.uploads, "views_median": d.views_median}
                    for d in state.days[-7:]
                ],
            }
        return {
            # v0.13：条目带内容分层标记（premier/regular/filler）——队列行徽章，
            # 让「策略已接管选条目」在 UI 上可见
            "ready": [self._serialize_with_tier(i) for i in ready],
            "holding": [self._serialize_with_tier(i) for i in holding],
            "today": {
                "auto_published": used,
                "daily_limit": daily_limit,
                "auto_enabled": bool(getattr(self.engine.settings, "pipeline_auto_publish", False)),
            },
            # 关闭时为 None——前端据此隐藏状态卡
            "account": account,
            # 影子计划（v0.18）：dry_run 下策略的「将会做什么」（最近一次）
            "shadow_plan": list(getattr(self, "_shadow_plan", []) or []),
        }

    def _serialize_with_tier(self, item) -> dict:
        """序列化 + 内容分层标记（v0.13）。"""
        from backend.pipeline.strategy import content_tier

        data = self._serialize(item)
        data["tier"] = content_tier(item)
        return data
