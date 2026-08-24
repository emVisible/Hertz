"""PipelineService 发布·队列·排期域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.base import StepContext
from backend.pipeline.errors import ItemNotFoundError
from backend.pipeline.helpers import _auto_tid as helpers_auto_tid

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
                script["bili_title"] = bili_title.strip()
            if bili_desc is not None:
                script["bili_desc"] = bili_desc.strip()
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
                script["bili_copyright"] = 1
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

    def _strategy_cfg(self):
        """发布策略参数（v0.13）：settings → StrategyConfig。全部阈值
        runtime 可调（设置页/PUT config），规则骨架见 strategy.py 模块注释。"""
        from backend.pipeline.strategy import StrategyConfig

        s = self.engine.settings
        return StrategyConfig(
            enabled=bool(getattr(s, "pipeline_strategy_enabled", False)),
            base_daily=int(getattr(s, "pipeline_strategy_base_daily", 2) or 2),
            warmup_floor=int(getattr(s, "pipeline_strategy_warmup_floor", 30) or 30),
            warmup_step=int(getattr(s, "pipeline_strategy_warmup_step", 10) or 10),
            drop_ratio=float(getattr(s, "pipeline_strategy_drop_ratio", 0.5)),
            cooldown_floor_views=int(
                getattr(s, "pipeline_strategy_cooldown_floor_views", 10) or 10
            ),
            cooldown_streak_days=int(
                getattr(s, "pipeline_strategy_cooldown_streak_days", 2) or 2
            ),
            min_same_tid_gap_h=int(getattr(s, "pipeline_strategy_min_same_tid_gap_h", 6) or 6),
            premier_score=float(getattr(s, "pipeline_strategy_premier_score", 8.0)),
        )

    async def _current_account_state(self, now: datetime):
        """账号画像（v0.13）：全量计数定 warmup + 近 45 日明细定健康度。

        账号状态是 items 的派生数据（AXIOM 单一真相源）——tick 每 5 分钟
        重算一次，查询量级为几十行，无需缓存/落库。
        """
        from backend.pipeline.strategy import account_state

        cfg = self._strategy_cfg()
        cutoff = now - timedelta(days=45)
        async with session_factory() as session:
            total = await session.scalar(
                select(func.count(Item.id)).where(
                    Item.status == ItemStatus.PUBLISHED, Item.archived.is_(False),
                )
            )
            recent = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.PUBLISHED,
                        Item.published_at.isnot(None),
                        Item.published_at >= cutoff,
                        Item.archived.is_(False),
                    )
                )
            ).scalars().all()
        return account_state(recent, now=now, cfg=cfg, total_published=int(total or 0))

    async def _auto_promote_now(self, now: datetime) -> int:
        """每日转正：holding → ready（自动分配当天窗口槽位，窗口排满保持 holding）。

        v0.13：策略开启时由发布策略引擎接管——账号健康度定配额、内容分层选
        条目、同分区间隔 + 相邻分区去重；关闭时保持静态转正数行为。"""
        from backend.pipeline.publish_queue import PHASE_HOLDING, PHASE_READY
        from backend.pipeline.schedule import next_slot

        settings = self.engine.settings
        if self._strategy_cfg().enabled:
            return await self._strategy_promote(now)

        daily_n = int(getattr(settings, "pipeline_auto_promote_daily", 3) or 0)
        if daily_n <= 0:
            return 0
        async with session_factory() as session:
            candidates = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_HOLDING,
                        Item.archived.is_(False),
                    ).order_by(Item.seq.asc()).limit(daily_n)
                )
            ).scalars().all()
            if not candidates:
                return 0
            allocated = [
                t for t in
                (await session.execute(
                    select(Item.scheduled_at).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_READY,
                        Item.scheduled_at.isnot(None),
                        Item.scheduled_at >= now,
                    )
                )).scalars().all()
                if t is not None
            ]
            promoted = 0
            for item in candidates:
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
                    continue  # 窗口排满 → 保持 holding，次日再转
                item.queue_phase = PHASE_READY
                item.scheduled_at = slot
                allocated.append(slot)
                promoted += 1
            await session.commit()
        return promoted

    async def _strategy_promote(self, now: datetime) -> int:
        """策略转正（v0.13）：健康度配额 × 内容分层选条目 × 槽位规划。

        cooldown 日 quota=0 → 不转正任何条目（全自动停发）；窗口排满时
        剩余保持 holding（与静态路径语义一致）。
        """
        from backend.pipeline.publish_queue import PHASE_HOLDING, PHASE_READY
        from backend.pipeline.strategy import daily_quota, plan_promotions

        cfg = self._strategy_cfg()
        state = await self._current_account_state(now)
        quota = daily_quota(state, cfg=cfg)
        if quota <= 0:
            logger.info(
                "strategy promote: phase=%s quota=0 — skip (%s)",
                state.phase, "; ".join(state.reasons)[:200],
            )
            return 0

        async with session_factory() as session:
            holding = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_HOLDING,
                        Item.archived.is_(False),
                    ).order_by(Item.seq.asc()).limit(200)
                )
            ).scalars().all()
            if not holding:
                return 0
            # 有效分区（v0.13）：手动 script_json.bili_tid 优先，否则按来源推荐。
            # Item 无 tid 列——挂在实例属性上供策略层纯函数读取（不落库）
            for it in holding:
                manual = (it.script_json or {}).get("bili_tid")
                suggested = helpers_auto_tid(it)
                it.auto_tid = int(manual or suggested or 0)
            ready_items = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.APPROVED,
                        Item.queue_phase == PHASE_READY,
                        Item.scheduled_at.isnot(None),
                        Item.archived.is_(False),
                    )
                )
            ).scalars().all()
        existing_ready = []
        for it in ready_items:
            if it.scheduled_at is None:
                continue
            manual = (it.script_json or {}).get("bili_tid")
            existing_ready.append(
                (it.scheduled_at, int(manual or helpers_auto_tid(it) or 0))
            )
        plan = plan_promotions(
            holding, quota=quota, existing_ready=existing_ready, now=now,
            windows_raw=getattr(self.engine.settings, "pipeline_publish_windows", ""),
            min_interval_min=int(
                getattr(self.engine.settings, "pipeline_publish_min_interval_min", 30)
            ),
            cfg=cfg,
            # v0.11.5 决策对齐：只排当天——窗口满保持 holding（次日再转），
            # 不因策略路径悄悄把排期推到未来几天
            lookahead_days=1,
        )
        if not plan:
            return 0
        slots = {item.id: slot for item, slot in plan}
        # 影子模式（v0.18）：照常计算不落库——记录「影子计划」供 queue_view
        # 展示，建立信任后关闭 dry_run 即无缝切真实执行
        if bool(getattr(self.engine.settings, "pipeline_strategy_dry_run", False)):
            self._shadow_plan = [
                {
                    "title": (it.script_json or {}).get("bili_title") or it.title,
                    "subreddit": it.subreddit,
                    "scheduled_at": slot.isoformat(),
                }
                for it, slot in plan
            ][:20]
            logger.info(
                "strategy DRY-RUN: phase=%s quota=%d would promote=%d",
                state.phase, quota, len(plan),
            )
            return 0
        async with session_factory() as session:
            rows = (
                await session.execute(select(Item).where(Item.id.in_(slots.keys())))
            ).scalars().all()
            for row in rows:
                row.queue_phase = PHASE_READY
                row.scheduled_at = slots[row.id]
            await session.commit()
        logger.info(
            "strategy promote: phase=%s quota=%d promoted=%d",
            state.phase, quota, len(plan),
        )
        return len(plan)

    async def _auto_published_today_count(self, now: datetime) -> int:
        """今日产能已用：本地日 + publish_json.auto 标记（手动发布不计）。"""
        from backend.pipeline.publish_queue import local_day_bounds

        day_start, day_end = local_day_bounds(now)
        async with session_factory() as session:
            count = await session.scalar(
                select(func.count(Item.id)).where(
                    Item.status == ItemStatus.PUBLISHED,
                    Item.published_at >= day_start,
                    Item.published_at < day_end,
                    Item.archived.is_(False),
                    Item.publish_json["auto"].astext == "true",
                )
            )
        return int(count or 0)

    async def auto_publish_tick(self) -> dict:
        """自动发布主逻辑（调度器周期调用）：转正 + 到点发布 + 产能上限。

        顺序：总开关关 → 跳过；当天首个 tick 转正；产能已满 → 只转正不发布；
        发布 ready & approved & scheduled_at ≤ now（按排期升序），发满上限即停；
        单条失败 → 标记 failed（error_class=publish），不阻塞其余。
        跨天未发完的 ready 条目（排期已过期）→ 重新分配当天窗口，次日自然续发。
        """
        from datetime import UTC

        from backend.pipeline.errors import InvalidItemStateError
        from backend.pipeline.publish_queue import PHASE_READY
        from backend.pipeline.schedule import next_slot
        from backend.pipeline.strategy import daily_quota

        settings = self.engine.settings
        if not bool(getattr(settings, "pipeline_auto_publish", False)):
            return {"enabled": False, "promoted": 0, "published": 0, "failed": 0}
        now = datetime.now(UTC)
        local_day = now.astimezone(datetime.now().astimezone().tzinfo).date().isoformat()
        promoted = 0
        if getattr(self, "_last_promote_day", None) != local_day:
            try:
                promoted = await self._auto_promote_now(now)
            except Exception:  # noqa: BLE001 — 转正失败不拖垮 tick
                logger.exception("auto publish: promote failed (best effort)")
            self._last_promote_day = local_day

        daily_limit = int(getattr(settings, "pipeline_auto_publish_daily_limit", 5) or 5)
        # v0.13：策略开启 → 产能由账号健康度决定（cooldown=0 自动停发）
        strategy_state = None
        if self._strategy_cfg().enabled:
            strategy_state = await self._current_account_state(now)
            daily_limit = daily_quota(strategy_state, cfg=self._strategy_cfg())
        used = await self._auto_published_today_count(now)
        published = failed = 0
        while used < daily_limit:
            async with session_factory() as session:
                due = (
                    await session.execute(
                        select(Item).where(
                            Item.status == ItemStatus.APPROVED,
                            Item.queue_phase == PHASE_READY,
                            Item.scheduled_at.isnot(None),
                            Item.scheduled_at <= now,
                            Item.archived.is_(False),
                        ).order_by(Item.scheduled_at.asc()).limit(daily_limit - used)
                    )
                ).scalars().all()
            if not due:
                break
            for item in due:
                try:
                    await self.publish_one(item.id, auto=True)
                    published += 1
                    used += 1
                except InvalidItemStateError:
                    continue  # 并发（手动/其他 tick）已发布/状态迁移
                except Exception as exc:  # noqa: BLE001 — 单条失败标记 failed，不阻塞
                    async with session_factory() as session:
                        row = await session.get(Item, item.id)
                        if row is not None and row.status == ItemStatus.APPROVED:
                            row.status = ItemStatus.FAILED
                            row.error = f"auto publish failed: {exc}"
                            row.error_class = "publish"
                            await session.commit()
                            failed += 1
        # 跨天遗留：仍 ready 但排期已过（昨天发满未发）→ 重排当天窗口
        if daily_limit > 0:
            async with session_factory() as session:
                stale = (
                    await session.execute(
                        select(Item).where(
                            Item.status == ItemStatus.APPROVED,
                            Item.queue_phase == PHASE_READY,
                            Item.scheduled_at.isnot(None),
                            Item.scheduled_at < now,
                            Item.archived.is_(False),
                        ).order_by(Item.seq.asc()).limit(30)
                    )
                ).scalars().all()
                for item in stale:
                    slot = next_slot(
                        [],
                        now=now,
                        windows_raw=getattr(settings, "pipeline_publish_windows", ""),
                        min_interval_min=int(
                            getattr(settings, "pipeline_publish_min_interval_min", 30)
                        ),
                        jitter_min=0,
                        lookahead_days=1,
                    )
                    if slot is not None:
                        item.scheduled_at = slot
                await session.commit()
        return {
            "enabled": True, "promoted": promoted,
            "published": published, "failed": failed,
            "used_today": used, "daily_limit": daily_limit,
            # v0.13：策略相位与证据（前端状态卡直显；关闭时为 None）
            "strategy_phase": strategy_state.phase if strategy_state else None,
        }

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
