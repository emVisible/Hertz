"""PipelineService — execution-domain service facade.

Owns batch-run lifecycle (single-flight guard, background tasks), the item
review API and event wiring. The heavy lifting is delegated to StepEngine.
"""

import asyncio
import logging
import uuid

from sqlalchemy import select

from backend.infrastructure.events import EventHub
from backend.models.item import Item
from backend.models.pipeline import SourceState
from backend.models.session import session_factory
from backend.models.system import JobRun
from backend.pipeline.engine import StepEngine

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

    # ---------- queries ----------

    async def list_items(
        self, status: str | None = None, limit: int = 50, source: str | None = None
    ) -> list[dict]:
        async with session_factory() as session:
            order = Item.created_at.desc()
            # Combine filters instead of overwriting: status+source must not
            # silently drop one of them (AXIOM §7.4 / §1.2).
            stmt = select(Item).order_by(order).limit(limit)
            conditions = []
            if status:
                conditions.append(Item.status == status)
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
        async with session_factory() as session:
            result = await session.execute(
                select(SourceState).order_by(SourceState.channel)
            )
            return [
                {
                    "source": s.source,
                    "channel": s.channel,
                    "cursor": s.get_cursor(),
                    "ok_count": s.ok_count,
                    "fail_count": s.fail_count,
                    "last_run_at": s.last_run_at.isoformat() if s.last_run_at else None,
                }
                for s in result.scalars().all()
            ]

    @staticmethod
    def _serialize(item: Item) -> dict:
        return {
            "id": str(item.id),
            "status": item.status,
            "item_type": item.item_type,
            "source": item.source,
            "source_url": item.source_url,
            "source_id": item.source_id,
            "title": item.title,
            "subreddit": item.subreddit,
            "author": item.author,
            "reddit_score": item.reddit_score,
            "upvote_ratio": item.upvote_ratio,
            "score_total": item.score_total,
            "score_reasons": item.score_reasons or [],
            "raw_path": item.raw_path,
            "video_path": item.video_path,
            "cover_path": item.cover_path,
            "script_json": item.script_json,
            "publish_json": item.publish_json,
            "error": item.error,
            "retry_count": item.retry_count,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "approved_at": item.approved_at.isoformat() if item.approved_at else None,
            "published_at": item.published_at.isoformat() if item.published_at else None,
        }
