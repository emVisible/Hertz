"""StepEngine — batch executor for the content pipeline.

Drives Items through the five steps: collect → download → score → produce →
publish (v5.9: 下载在评分之前，审核为人工 gate)。The engine owns status
transitions; each step only declares what it consumes and produces. Progress
is broadcast via EventHub on the ``pipeline`` topic; batch runs are recorded
in job_runs for audit.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.models.system import JobRun, JobStatus
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError, classify_error
from backend.pipeline.steps import get_step
from backend.pipeline.steps.collect import run_collect

logger = logging.getLogger(__name__)

# Steps that consume items in status order; collect is batch-only.
# v5.9 流程：download → score → produce → (audit 人工) → publish
STEP_ORDER = ("collect", "download", "score", "produce", "publish")


class StepEngine:
    def __init__(self, hub, settings, ai=None, collector=None, publishers=None) -> None:
        self.hub = hub
        self.settings = settings
        self.ai = ai
        self.collector = collector
        self.publishers = publishers or {}

    # ---------- public ----------

    async def run_batch(self, job_name: str, *, limit: int = 10, channel: str = "") -> dict:
        """Run one step (or the full chain) over ready items. Records a JobRun."""
        run_id = uuid.uuid4()
        job = JobRun(job_name=job_name, status=JobStatus.RUNNING)
        async with session_factory() as session:
            session.add(job)
            await session.commit()
            await session.refresh(job)

        ctx = StepContext(
            run_id=str(run_id),
            settings=self.settings,
            ai=self.ai,
            emit=lambda e: self._emit(str(job.id), e),
        )

        # 运行前后数据差异（v0.3.5）：各状态计数快照 → delta 随 job_done 下发
        before = await self._counts()

        try:
            summary = await self._run_step(ctx, job_name, limit=limit, channel=channel)
            job.status = JobStatus.COMPLETED
            job.summary = summary
        except asyncio.CancelledError:
            job.status = JobStatus.FAILED
            job.error = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001 — persist the crash
            logger.exception("pipeline job %s crashed", job_name)
            job.status = JobStatus.FAILED
            job.error = str(exc)[:500]
            summary = {"error": str(exc)[:500]}
        finally:
            job.finished_at = datetime.now(UTC)
            async with session_factory() as session:
                await session.merge(job)
                await session.commit()

        summary = dict(summary or {})
        try:
            after = await self._counts()
            delta = {
                status: after.get(status, 0) - before.get(status, 0)
                for status in set(before) | set(after)
                if after.get(status, 0) != before.get(status, 0)
            }
            if delta:
                summary["delta"] = delta
        except Exception:  # noqa: BLE001 — diff 是增强，失败不阻塞主流程
            logger.warning("delta snapshot failed for job %s", job_name)
        job.summary = summary

        self._emit(
            str(job.id),
            {"type": "job_done", "job": job_name, "status": job.status, "summary": summary},
        )
        return {"job_id": str(job.id), "job": job_name, "status": job.status, "summary": summary}

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict:
        """Run collect → download → score → produce in sequence (review gate before publish)."""
        results: dict[str, dict] = {}
        for step in STEP_ORDER:
            if step == "publish":
                continue  # publish requires human approval
            results[step] = await self.run_batch(step, limit=limit, channel=channel)
        return results

    async def process_one(self, step_name: str, item_id: uuid.UUID) -> str:
        """单条处理（v0.3.4，预处理「制作」按钮）：指定步骤处理单个条目。

        复用 _process_item（状态落库 + 事件），返回 outcome（ok/rejected/failed）。
        """
        step_cls = get_step(step_name)
        step = step_cls()
        async with session_factory() as session:
            item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        if item.status not in step.input_statuses:
            raise InvalidItemStateError(
                f"step {step_name} cannot process item in state {item.status}"
            )
        ctx = StepContext(
            run_id=str(uuid.uuid4()),
            settings=self.settings,
            ai=self.ai,
            emit=lambda e: self._emit("item:" + item_id.hex, e),
        )
        outcome = await self._process_item(ctx, step, item)
        self._emit("pipeline", {"type": "job_step", "step": step_name, "count": 1})
        return outcome

    # ---------- per-item actions (review / retry) ----------

    async def approve(self, item_id: uuid.UUID) -> dict:
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status != ItemStatus.QUEUED:
                raise InvalidItemStateError(f"cannot approve item in state {item.status}")
            item.status = ItemStatus.APPROVED
            item.approved_at = datetime.now(UTC)
            await session.merge(item)
            await session.commit()
        item_event = {"type": "item", "item_id": str(item_id), "status": "approved"}
        self._emit("item:" + item_id.hex, item_event)
        return {"id": str(item_id), "status": "approved"}

    async def reject(self, item_id: uuid.UUID, reason: str = "") -> dict:
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            # v0.3.4：预处理阶段的 discovered（未下载）也可拒绝——人工筛掉不想要的源
            if item.status not in (
                ItemStatus.QUEUED, ItemStatus.SCORED, ItemStatus.DOWNLOADED, ItemStatus.DISCOVERED,
            ):
                raise InvalidItemStateError(f"cannot reject item in state {item.status}")
            item.status = ItemStatus.REJECTED
            item.error = reason or "rejected at review"
            await session.merge(item)
            await session.commit()
        item_event = {"type": "item", "item_id": str(item_id), "status": "rejected"}
        self._emit("item:" + item_id.hex, item_event)
        return {"id": str(item_id), "status": "rejected"}

    async def retry(self, item_id: uuid.UUID) -> dict:
        """Reset a failed item back to its previous state so a run picks it up again.

        v5.9 流程回退：有成片 → scored（重制）；已下载 → downloaded（重评分）；
        否则 → discovered（重下载）。
        """
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status != ItemStatus.FAILED:
                raise InvalidItemStateError(f"cannot retry item in state {item.status}")
            back = (
                "scored" if item.video_path
                else ("downloaded" if item.raw_path else "discovered")
            )
            item.status = back
            item.error = None
            item.retry_count += 1
            await session.merge(item)
            await session.commit()
        return {"id": str(item_id), "status": item.status}

    async def requeue(self, item_id: uuid.UUID) -> dict:
        """Restore an item back to review (queued): rejected or approved both work."""
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status not in (ItemStatus.REJECTED, ItemStatus.APPROVED):
                raise InvalidItemStateError(f"cannot requeue item in state {item.status}")
            item.status = ItemStatus.QUEUED
            item.error = None
            await session.merge(item)
            await session.commit()
        self._emit(
            "item:" + item_id.hex, {"type": "item", "item_id": str(item_id), "status": "queued"}
        )
        return {"id": str(item_id), "status": "queued"}

    # ---------- internals ----------

    async def _counts(self) -> dict[str, int]:
        """各状态计数快照（v0.3.5，job 前后 diff 用）。"""
        from sqlalchemy import func

        async with session_factory() as session:
            rows = await session.execute(
                select(Item.status, func.count()).group_by(Item.status)
            )
            return {str(status): count for status, count in rows.all()}

    async def _run_step(self, ctx: StepContext, job_name: str, *, limit: int, channel: str) -> dict:
        if job_name == "collect":
            if self.collector is None:
                raise RuntimeError("no collector configured")
            ctx.log(f"[collect] channel={channel or 'hot'} limit={limit}")
            # 采集韧性（v0.2.1，参考原项目冷却/熔断）：失败后进入冷却期，冷却中跳过
            cooldown_s = await self._collect_cooldown_left(self.collector.name, channel or "hot")
            if cooldown_s > 0:
                ctx.log(f"[collect] {channel or 'hot'} cooling down ({cooldown_s}s left)")
                summary = {"channel": channel or "hot", "cooldown_s": cooldown_s}
                self._emit(ctx.run_id, {"type": "job_step", "step": "collect", **summary})
                return summary
            try:
                summary = await run_collect(ctx, channel or "hot", limit, self.collector)
            except Exception as exc:  # noqa: BLE001 — 记录失败到数据源健康度后重抛
                await self._record_collect_failure(self.collector.name, channel or "hot", str(exc))
                raise
            if summary.get("collected", 0) == 0:
                # 接口正常但 0 条（v0.2.8，参考原项目 failed_subs/供给告警）：
                # 源可能挂/被 block 返回空列表——记健康度 + 冷却，不静默标 ✓
                await self._record_collect_empty(
                    self.collector.name, channel or "hot", summary
                )
                summary["empty"] = True
            else:
                await self._clear_collect_cooldown(self.collector.name, channel or "hot")
            self._emit(ctx.run_id, {"type": "job_step", "step": "collect", **summary})
            return summary

        step_cls = get_step(job_name)
        step = step_cls()
        items = await self._pending(job_name, step, limit)
        ctx.log(f"[{job_name}] processing {len(items)} item(s)")
        self._emit(ctx.run_id, {"type": "job_step", "step": job_name, "count": len(items)})

        results = {"processed": len(items), "ok": 0, "rejected": 0, "failed": 0, "skipped": 0}
        for item in items:
            outcome = await self._process_item(ctx, step, item)
            results[outcome] += 1
        return results

    async def _pending(self, job_name: str, step: Pipe, limit: int) -> list[Item]:
        if not step.input_statuses:
            return []
        async with session_factory() as session:
            result = await session.execute(
                select(Item)
                .where(Item.status.in_(step.input_statuses))
                .order_by(Item.created_at.asc())
                .limit(limit)
            )
            return list(result.scalars().all())

    async def _process_item(self, ctx: StepContext, step: Pipe, item: Item) -> str:
        result: ProcessResult | None = None
        error = ""
        try:
            result = await step.process(ctx, item)
        except StepError as exc:
            error = str(exc)
        except Exception as exc:  # noqa: BLE001 — any crash fails the item
            logger.exception("step %s crashed for item %s", step.name, item.id)
            error = f"internal: {exc}"

        if result is None:
            outcome = "failed"
            new_status = ItemStatus.FAILED
        else:
            new_status = result.status
            outcome = (
                "skipped"  # v0.3.6：冷却/熔断等跳过，摘要不再误报「成功」
                if result.skip
                else "failed" if new_status == ItemStatus.FAILED else (
                    "rejected" if new_status == ItemStatus.REJECTED else "ok"
                )
            )

        async with session_factory() as session:
            row = await session.get(Item, item.id)
            if row is None:
                return outcome
            row.status = new_status
            if new_status == ItemStatus.FAILED:
                row.error = error or (result.error if result else None)
                # 失败分类（v0.2.1）：同类批量重试的数据基础
                row.error_class = classify_error(row.error or "", step.name)
            else:
                row.error = None
                row.error_class = ""
            for field, value in (result.data if result else {}).items():
                setattr(row, field, value)
            await session.merge(row)
            await session.commit()

        self._emit(
            "item:" + item.id.hex,
            {
                "type": "item",
                "item_id": str(item.id),
                "step": step.name,
                "status": new_status,
                "error": error or None,
            },
        )
        return outcome

    async def _record_collect_empty(self, source: str, channel: str, summary: dict) -> None:
        """采集 0 条记账（v0.2.8）：源返回空列表视为异常——健康度失败计数 +
        10 分钟短冷却（连续 0 条叠加熔断逻辑），下次跳过避免空转。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    state = SourceState(source=source, channel=channel)
                    session.add(state)
                state.fail_count += 1
                state.consecutive_fails += 1
                state.last_error = (
                    f"collected 0 items (empty response, skipped={summary.get('skipped', 0)})"
                )
                state.last_error_at = datetime.now(UTC)
                cooldowns = state.get_cooldowns()
                cooldowns["default"] = datetime.now(UTC).timestamp() + 600  # 10 分钟
                state.set_cooldowns(cooldowns)
                await session.commit()
                logger.warning(
                    "collect %s:%s returned 0 items — cooldown 600s (consecutive %d)",
                    source, channel, state.consecutive_fails,
                )
        except Exception:  # noqa: BLE001 — 健康度记账失败不阻塞采集主流程
            logger.exception("failed to record empty collect for %s:%s", source, channel)

    async def _record_collect_failure(self, source: str, channel: str, error: str) -> None:
        """采集失败记账（数据源健康度 v0.2.1）：连续失败 + 失败计数 + 最后错误 + 冷却。

        冷却/熔断：基础 30 分钟；连续失败 ≥3（熔断）翻倍到 2 小时。
        """
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    state = SourceState(source=source, channel=channel)
                    session.add(state)
                state.fail_count += 1
                state.consecutive_fails += 1
                state.last_error = str(error)[:500]
                state.last_error_at = datetime.now(UTC)
                cooldown_s = 3600 * 2 if state.consecutive_fails >= 3 else 1800
                cooldowns = state.get_cooldowns()
                cooldowns["default"] = datetime.now(UTC).timestamp() + cooldown_s
                state.set_cooldowns(cooldowns)
                await session.commit()
                logger.warning(
                    "collect %s:%s failed — cooldown %ds (consecutive %d)",
                    source, channel, cooldown_s, state.consecutive_fails,
                )
        except Exception:  # noqa: BLE001 — 健康度记账失败不阻塞采集主流程
            logger.exception("failed to record collect failure for %s:%s", source, channel)

    async def _collect_cooldown_left(self, source: str, channel: str) -> int:
        """冷却剩余秒数（>0 = 冷却中，跳过本轮采集）。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    return 0
                until = state.get_cooldowns().get("default", 0.0)
                left = int(until - datetime.now(UTC).timestamp())
                return max(left, 0)
        except Exception:  # noqa: BLE001 — 冷却查询失败按无冷却处理
            return 0

    async def _clear_collect_cooldown(self, source: str, channel: str) -> None:
        """采集成功 → 清除冷却（恢复即清零）。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None or not state.get_cooldowns():
                    return
                state.set_cooldowns({})
                await session.commit()
        except Exception:  # noqa: BLE001 — 清除失败不影响主流程
            logger.exception("failed to clear cooldown for %s:%s", source, channel)

    def _emit(self, topic: str, event: dict) -> None:
        if self.hub is not None:
            self.hub.publish("pipeline", event)
            if topic:
                self.hub.publish(f"pipeline:{topic}", event)
