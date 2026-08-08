"""collect step — fetch posts from a source and persist new Items (DISCOVERED).

Dedupe keys: (source, source_id) unique per item — a re-collect with the same
external id updates nothing. Cursor (oldest created_utc) is stored on
SourceState so later runs only pull newer posts.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.pipeline import SourceState
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext

logger = logging.getLogger(__name__)


class CollectStep(Pipe):
    name = "collect"
    input_statuses: tuple[str, ...] = ()

    async def process(self, ctx: StepContext, item) -> ProcessResult:  # pragma: no cover
        raise RuntimeError("collect is a batch step; it does not process items")


async def run_collect(ctx: StepContext, channel: str, limit: int, collector) -> dict:
    """Batch collection for one channel. Returns a summary dict."""
    from backend.pipeline.collectors.base import SourceCollector

    if not isinstance(collector, SourceCollector):
        raise TypeError("collector must be a SourceCollector")

    posts = await collector.collect(ctx, channel, limit)
    inserted = skipped = 0

    async with session_factory() as session:
        state = (
            await session.execute(
                select(SourceState).where(
                    SourceState.source == collector.name,
                    SourceState.channel == channel,
                )
            )
        ).scalar_one_or_none()
        if state is None:
            state = SourceState(source=collector.name, channel=channel)
            session.add(state)

        existing = set(
            (
                await session.execute(
                    select(Item.source_id).where(Item.source == collector.name)
                )
            ).scalars()
        )

        for post in posts:
            if post.source_id in existing:
                skipped += 1
                continue
            item = Item(
                status=ItemStatus.DISCOVERED,
                item_type=post.item_type,
                source=collector.name,
                source_url=post.source_url,
                media_url=post.media_url or None,
                source_id=post.source_id,
                title=post.title,
                subreddit=channel.split(":", 1)[0],
                author=post.author,
                reddit_score=post.score,
                upvote_ratio=post.upvote_ratio,
                num_comments=post.num_comments,
                error=None,
            )
            session.add(item)
            existing.add(post.source_id)
            inserted += 1

        if posts:
            state.set_cursor({"oldest_created_utc": min(p.created_utc for p in posts)})
            state.last_strategy = collector.name
            state.last_run_at = datetime.now(UTC)
            state.ok_count += 1
            state.consecutive_fails = 0  # 数据源健康度：成功即清零连续失败
        await session.commit()

    return {"channel": channel, "collected": len(posts), "inserted": inserted, "skipped": skipped}
