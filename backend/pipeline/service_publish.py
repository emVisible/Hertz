"""PipelineService 发布·队列·排期域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.base import StepContext
from backend.pipeline.errors import ItemNotFoundError
from backend.pipeline.helpers import _auto_tid as helpers_auto_tid

logger = logging.getLogger(__name__)



class PublishMixin:
    # ---------- publish (独立人工环节，v5.10) ----------

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
        result = await publisher.publish(ctx, item)
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

    # ---------- 发布队列（v0.12：预发布/发布队列 + 每日产能自动发布） ----------

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
        }

    def _serialize_with_tier(self, item) -> dict:
        """序列化 + 内容分层标记（v0.13）。"""
        from backend.pipeline.strategy import content_tier

        data = self._serialize(item)
        data["tier"] = content_tier(item)
        return data

    # ---------- 发布数据（v0.4 C1：回捞 + 手动补录） ----------

    async def refresh_publish_stats(self, *, limit: int = 50) -> dict:
        """回捞已发布条目的播放/互动（调度器周期调用，best-effort）。

        仅处理 publish_json 带 bvid 且 stats 过期（>12h）的条目；
        403/异常静默跳过，不阻塞主流程。
        """
        from datetime import UTC, datetime

        from backend.pipeline.publish_stats import fetch_bvid_stats, stats_expired

        updated = skipped = 0
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item)
                    .where(Item.status == ItemStatus.PUBLISHED)
                    .order_by(Item.published_at.desc().nulls_last())
                    .limit(limit)
                )
            ).scalars().all()
            for row in rows:
                pub = dict(row.publish_json or {})
                if not stats_expired(pub):
                    skipped += 1
                    continue
                bvid = pub.get("bvid")
                if not bvid:
                    skipped += 1
                    continue
                stats = await fetch_bvid_stats(str(bvid))
                if stats is None:
                    skipped += 1
                    continue
                pub["stats"] = stats
                pub["stats_at"] = datetime.now(UTC).isoformat()
                row.publish_json = pub
                updated += 1
            if updated:
                await session.commit()
        return {"updated": updated, "skipped": skipped}

    async def set_publish_stats(
        self, item_id: uuid.UUID, stats: dict
    ) -> dict:
        """手动补录发布数据（发布历史行，自动回捞失败时的降级入口）。"""
        from datetime import UTC, datetime

        from backend.pipeline.publish_stats import _STAT_KEYS

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            pub = dict(item.publish_json or {})
            picked = {k: int(stats.get(k) or 0) for k in _STAT_KEYS}
            pub["stats"] = picked
            pub["stats_at"] = datetime.now(UTC).isoformat()
            item.publish_json = pub
            await session.merge(item)
            await session.commit()
        return {"id": str(item_id), "ok": True, "stats": picked}

    async def score_one(self, item_id: uuid.UUID) -> dict:
        """单条评分（v0.3.5，预处理手动评分按钮）：v0.8.6 评分先行——仅未评分条目。"""
        from backend.pipeline.errors import InvalidItemStateError

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status != ItemStatus.DISCOVERED:
                raise InvalidItemStateError(
                    f"cannot score item in state {item.status}"
                )
        outcome = await self.engine.process_one("score", item_id)
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "score failed"
            raise RuntimeError(error)
        return {"id": str(item_id), "status": "scored", "outcome": outcome}

    async def download_one(self, item_id: uuid.UUID, skip_score: bool = False) -> dict:
        """单条下载（v0.8.6 评分先行，预处理手动下载按钮）：默认仅已评分未下载
        条目。v0.11.10：skip_score=True 放行 discovered——省 API 余额场景绕过评分
        直接下载（审核以人工判断为主，评分为辅助信号）。"""
        from backend.pipeline.errors import InvalidItemStateError

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            # 双道校验同步放宽：service 层 + engine.process_one（status 为
            # String 列读回 str，engine 层按字符串元组比较）
            allowed = ("discovered", "scored") if skip_score else ("scored",)
            if item.status not in allowed:
                raise InvalidItemStateError(
                    f"cannot download item in state {item.status}"
                )
        outcome = await self.engine.process_one(
            "download", item_id,
            input_statuses=allowed if skip_score else None,
        )
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "download failed"
            raise RuntimeError(error)
        return {"id": str(item_id), "status": "downloaded", "outcome": outcome}

    async def download_unscored(self, limit: int = 10) -> dict:
        """批量直下（v0.11.10，预处理「直接下载」按钮）：对全部未评分
        （discovered）条目执行下载，跳过评分环节——API 余额不足时省着用。
        复用 single-flight 队列（运行中 409）。"""
        return await self.run_batch(
            "download", limit=limit, input_statuses=("discovered",)
        )

    async def produce_one(self, item_id: uuid.UUID) -> dict:
        """单条制作（v0.3.4，预处理「制作」按钮）：v0.8.6 评分先行语义——
        produce 吃 downloaded（已下载未加工）；discovered 一键制作自动转入
        downloaded（跳过评分/下载，宽松快捷路径）。

        wave11 取消制作：开始前清除陈旧取消标志；产线检查点命中抛
        ItemCancelledError → 清理半成品回滚 downloaded，不标 failed。
        """
        from backend.pipeline.cancel import ItemCancelledError, clear_cancel
        from backend.pipeline.errors import InvalidItemStateError

        clear_cancel(item_id)
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status not in (ItemStatus.DISCOVERED, ItemStatus.DOWNLOADED):
                raise InvalidItemStateError(
                    f"cannot produce item in state {item.status}"
                )
            if not item.raw_path and (item.item_type or "") != "text_only":
                raise InvalidItemStateError(
                    "item not downloaded yet — run download first"
                )
            if item.status != ItemStatus.DOWNLOADED:
                item.status = ItemStatus.DOWNLOADED
                await session.commit()
        try:
            outcome = await self.engine.process_one("produce", item_id)
        except ItemCancelledError:
            # wave11：用户取消 → 清理半成品派生媒体，条目回 downloaded 干净态
            await self._rollback_cancelled_produce(item_id)
            return {"id": str(item_id), "status": "cancelled", "outcome": "cancelled"}
        finally:
            clear_cancel(item_id)
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "produce failed"
            raise RuntimeError(error)
        return {"id": str(item_id), "status": "queued", "outcome": outcome}

    async def _rollback_cancelled_produce(self, item_id: uuid.UUID) -> None:
        """取消制作收尾（wave11）：条目回滚到 downloaded 可再制作态。

        清理半成品（final.mp4/narration.mp3/subs/cover 等派生媒体），保留
        raw 源片；script_json 保留用户手动改过的发布元数据（purge 语义）。
        """
        from backend.pipeline.helpers import purge_derived_media

        async with session_factory() as session:
            row = await session.get(Item, item_id)
            if row is None:
                return
            await purge_derived_media(row)
            row.status = ItemStatus.DOWNLOADED
            row.error = None
            row.error_class = ""
            await session.merge(row)
            await session.commit()
        self.engine._emit(
            "item:" + item_id.hex,
            {"type": "item", "item_id": str(item_id), "status": "downloaded",
             "error": "cancelled"},
        )

    async def produce_cancel(self, item_id: uuid.UUID) -> dict:
        """取消单条制作（wave11）：置位协作取消标志——产线下一检查点
        （阶段间 / ffmpeg 0.25s 轮询）命中即中止，条目回滚 downloaded。
        """
        from backend.pipeline.cancel import request_cancel

        request_cancel(item_id)
        return {"ok": True, "cancelling": True}

    # ---------- 排期自动维护（v0.2.7） ----------

    async def reschedule_expired(self) -> int:
        """进入审核时调用：过期排期自动更新 + 未排期条目自动分配推荐槽位。

        - 过期（scheduled_at < now）→ next_slot 重新分配（不能排到过去）
        - 未排期的 queued/approved → 自动分配推荐槽位（每次进入系统都有排期，
          用户可再改）；单次最多 30 条，避免排期冲到遥远未来（§7.4 有界）
        """
        from datetime import UTC, datetime

        from backend.pipeline.publish_queue import PHASE_HOLDING
        from backend.pipeline.schedule import next_slot

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
                    lookahead_days=1,  # v0.11.5：只排当天，不要定到几天后
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
        from backend.pipeline.schedule import next_slot

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
            lookahead_days=1,  # v0.11.5：只排当天（用户需求）
        )
        # 当天无可用槽位 → 返回空（前端回退 now+5min 兜底）
        return slot.isoformat() if slot else ""

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
            # 发布队列相位（v0.12）：''=手动 / holding=预发布 / ready=发布队列
            "queue_phase": item.queue_phase,
            "error": item.error,
            "error_class": item.error_class,
            "retry_count": item.retry_count,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            # 最近操作（v0.3.12）：状态迁移自动刷新（onupdate）——「最新在前」排序要素
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            "approved_at": item.approved_at.isoformat() if item.approved_at else None,
            "scheduled_at": item.scheduled_at.isoformat() if item.scheduled_at else None,
            # 分区自动建议（v0.2.7，参考原项目 assign_bili_tid）：未手动设置时的推荐分区
            "auto_tid": (
                None
                if (item.script_json or {}).get("bili_tid")
                else helpers_auto_tid(item)
            ),
            "published_at": item.published_at.isoformat() if item.published_at else None,
            # 软归档（wave10）：备用库标记
            "archived": item.archived,
        }
