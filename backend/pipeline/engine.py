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
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError
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

        self._emit(str(job.id), {"type": "job_done", "job": job_name, "summary": summary})
        return {"job_id": str(job.id), "job": job_name, "status": job.status, "summary": summary}

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict:
        """Run collect → download → score → produce in sequence (review gate before publish)."""
        results: dict[str, dict] = {}
        for step in STEP_ORDER:
            if step == "publish":
                continue  # publish requires human approval
            results[step] = await self.run_batch(step, limit=limit, channel=channel)
        return results

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
            if item.status not in (ItemStatus.QUEUED, ItemStatus.SCORED, ItemStatus.DOWNLOADED):
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

    async def _run_step(self, ctx: StepContext, job_name: str, *, limit: int, channel: str) -> dict:
        if job_name == "collect":
            if self.collector is None:
                raise RuntimeError("no collector configured")
            ctx.log(f"[collect] channel={channel or 'hot'} limit={limit}")
            summary = await run_collect(ctx, channel or "hot", limit, self.collector)
            self._emit(ctx.run_id, {"type": "job_step", "step": "collect", **summary})
            return summary

        step_cls = get_step(job_name)
        step = step_cls()
        items = await self._pending(job_name, step, limit)
        ctx.log(f"[{job_name}] processing {len(items)} item(s)")
        self._emit(ctx.run_id, {"type": "job_step", "step": job_name, "count": len(items)})

        results = {"processed": len(items), "ok": 0, "rejected": 0, "failed": 0}
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
            outcome = "failed" if new_status == ItemStatus.FAILED else (
                "rejected" if new_status == ItemStatus.REJECTED else "ok"
            )

        async with session_factory() as session:
            row = await session.get(Item, item.id)
            if row is None:
                return outcome
            row.status = new_status
            if new_status == ItemStatus.FAILED:
                row.error = error or (result.error if result else None)
            else:
                row.error = None
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

    def _emit(self, topic: str, event: dict) -> None:
        if self.hub is not None:
            self.hub.publish("pipeline", event)
            if topic:
                self.hub.publish(f"pipeline:{topic}", event)
