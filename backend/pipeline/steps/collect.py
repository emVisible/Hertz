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


async def run_collect(
    ctx: StepContext, channel: str, limit: int, collector,
    filter_fn=None,
    channel_key: str | None = None,
) -> dict:
    """Batch collection for one channel. Returns a summary dict.

    v0.16：filter_fn（RawPost → bool）可选预筛——热点监控通道用三段词法
    在入库前过滤；普通通道不传即全量入库。被过滤条目计入 filtered 计数。
    v0.22：channel_key（栏目 public_id）可选——engine 按栏目源池匹配后传入，
    新入库条目打上归属；None = 未绑定（原行为，非破坏性默认）。
    """
    from backend.pipeline.collectors.base import SourceCollector
    from backend.pipeline.download import is_dead_reddit_media

    if not isinstance(collector, SourceCollector):
        raise TypeError("collector must be a SourceCollector")

    posts = await collector.collect(ctx, channel, limit)
    if filter_fn is not None:
        kept = [p for p in posts if filter_fn(p)]
        filtered = len(posts) - len(kept)
        posts = kept
    else:
        filtered = 0
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
            # 死 id 预筛（v0.2.9，参考原项目 _invalid_collect_media）：
            # 无 /comments/ 详情页的 v.redd.it 视频、1f1 结尾死 id——
            # 已知必死媒体不下车，采集时直接跳过（否则下载必然 404）
            if is_dead_reddit_media(post.media_url or "", post.source_url, post.source_id):
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
                selftext=post.selftext or None,
                channel_key=channel_key,
                error=None,
            )
            session.add(item)
            existing.add(post.source_id)
            inserted += 1

        if posts:
            state.set_cursor({"oldest_created_utc": min(p.created_utc for p in posts)})
            # v0.8.9 AXIOM 28：记录实际通道（此前写死 collector.name，零观测价值）
            state.last_strategy = getattr(collector, "_last_strategy", None) or collector.name
            state.last_run_at = datetime.now(UTC)
            state.ok_count += 1
            state.consecutive_fails = 0  # 数据源健康度：成功即清零连续失败
        await session.commit()

    return {
        "channel": channel, "collected": len(posts) + filtered,
        "inserted": inserted, "skipped": skipped,
        # v0.16 热点监控：词法预筛剔除数（观测采集质量）
        **({"filtered": filtered} if filter_fn is not None else {}),
    }
