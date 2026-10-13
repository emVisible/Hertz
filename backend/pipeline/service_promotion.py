"""策略转正与自动发布域（v0.22.x B 系第二批，自 PublishMixin 迁出）。

三层决策模型：账号健康度相位（warmup/normal/caution/cooldown）×
内容分层（premier/regular/filler）× 节奏规划（quota+slots，D-175）；
影子模式演练 + 产能计数。经 self 跨 Mixin 访问发布/队列能力
（组合类 PipelineService 单实例，无环）。
"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from backend.models import script_keys as sk
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.dedupe import DuplicateContentError
from backend.pipeline.errors import classify_error
from backend.pipeline.helpers import _auto_tid as helpers_auto_tid
from backend.pipeline.publish_reliability import PublishThrottledError
from backend.pipeline.schedule import _lookahead_days

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


class PromotionMixin:
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
        from backend.pipeline.schedule import _lookahead_days, next_slot

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
                    lookahead_days=_lookahead_days(self.engine.settings),
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
                manual = (it.script_json or {}).get(sk.BILI_TID)
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
            manual = (it.script_json or {}).get(sk.BILI_TID)
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
            # 默认仍是 1（v0.11.5「只排当天」：窗口满保持 holding、次日再转）。
            # v0.38 起读设置——想排超过 24 小时的用户可以主动调大它。
            lookahead_days=_lookahead_days(self.engine.settings),
        )
        if not plan:
            return 0
        slots = {item.id: slot for item, slot in plan}
        # 影子模式（v0.18）：照常计算不落库——记录「影子计划」供 queue_view
        # 展示，建立信任后关闭 dry_run 即无缝切真实执行
        if bool(getattr(self.engine.settings, "pipeline_strategy_dry_run", False)):
            self._shadow_plan = [
                {
                    "title": (it.script_json or {}).get(sk.BILI_TITLE) or it.title,
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

        from backend.pipeline.errors import InvalidItemStateError
        from backend.pipeline.publish_queue import PHASE_READY
        from backend.pipeline.schedule import _lookahead_days, next_slot
        from backend.pipeline.strategy import daily_quota

        settings = self.engine.settings
        if not bool(getattr(settings, "pipeline_auto_publish", False)):
            return {"enabled": False, "promoted": 0, "published": 0, "failed": 0,
                    "skipped": 0}
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
        published = failed = skipped = 0
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
            throttled = False
            for item in due:
                try:
                    await self.publish_one(item.id, auto=True)
                    published += 1
                    used += 1
                except InvalidItemStateError:
                    continue  # 并发（手动/其他 tick）已发布/状态迁移
                except DuplicateContentError as dup:
                    # v0.39：判重命中 → **跳过**，不是失败。
                    #
                    # 此前它掉进下面的兜底 except，被标成 FAILED + 写上
                    # 「auto publish failed: duplicate detected…」——用户看到一条
                    # 他从未发布过的内容被告知「发布失败」。代价还不止于此：
                    #   · 混进失败看板与失败分类分布，占掉「为什么发不出去」的答案位
                    #   · retry_count +1，把重试预算花在**确定性**的判定上——
                    #     闸的结论不会变，重试一万次还是同一条近源成片
                    #
                    # 终态由 publish_one 统一落库（手动/自动同一处语义），这里只计数。
                    skipped += 1
                    logger.info(
                        "[publish] 条目 #%s 因判重跳过（gate=%s）：%s",
                        item.id, dup.gate, dup,
                    )
                    continue
                except PublishThrottledError:
                    # v0.38：目标被限流 → **跳过，不标 FAILED**。
                    # 条目没坏、只是现在发不出去；标 FAILED 会让「今天还有几条
                    # 没发出去」这个最该被回答的问题失去答案，而且下一轮
                    # 不会再捞它（只有 APPROVED 会被 due 查询捞到）。
                    # 熔断期内剩下的条目一并跳过：继续撞只会加深限流。
                    throttled = True
                    continue
                except Exception as exc:  # noqa: BLE001 — 单条失败标记 failed，不阻塞
                    async with session_factory() as session:
                        row = await session.get(Item, item.id)
                        if row is not None and row.status == ItemStatus.APPROVED:
                            row.status = ItemStatus.FAILED
                            row.error = f"auto publish failed: {exc}"
                            # v0.38：按文本归类，而不是一律写死 "publish"。
                            #
                            # 一律写死会让**所有**发布失败落进同一个桶，失败看板
                            # （service_queries 按 error_class 聚合 + 批量重试）
                            # 于是答不出「为什么发不出去」——cookie 过期、限流、
                            # 视频格式问题看起来一模一样。
                            row.error_class = classify_error(str(exc), step="publish")
                            row.retry_count = int(row.retry_count or 0) + 1
                            await session.commit()
                            failed += 1
                if throttled:
                    logger.info("[publish] 目标限速中，本轮剩余条目留待下个 tick")
                    break
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
                        lookahead_days=_lookahead_days(self.engine.settings),
                    )
                    if slot is not None:
                        item.scheduled_at = slot
                await session.commit()
        return {
            "enabled": True, "promoted": promoted,
            "published": published, "failed": failed,
            # v0.39：判重跳过数与失败严格分开——「发不出去」和「不该发」是
            # 两个不同的问题，混在一个数里就都答不清了。
            "skipped": skipped,
            "used_today": used, "daily_limit": daily_limit,
            # v0.13：策略相位与证据（前端状态卡直显；关闭时为 None）
            "strategy_phase": strategy_state.phase if strategy_state else None,
        }
