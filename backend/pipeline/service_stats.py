"""统计回捞域（v0.22.x 自 PublishMixin 迁出）：B 站播放数据抓取落库 + 手动补录。"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import ItemNotFoundError

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


class StatsMixin:
    async def refresh_publish_stats(self, *, limit: int = 50) -> dict:
        """回捞已发布条目的播放/互动（调度器周期调用，best-effort）。

        仅处理 publish_json 带 bvid 且 stats 过期（>12h）的条目；
        403/异常静默跳过，不阻塞主流程。
        """

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

