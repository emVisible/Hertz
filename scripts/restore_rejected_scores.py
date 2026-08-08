"""v0.2.0 低分语义修正（一次性脚本）：恢复被自动拒绝的条目。

旧逻辑：评分低于阈值 → rejected（自动丢弃），且启发式回退（LLM 失败）
也曾被误拒。新语义：低分不丢弃——标记 is_lowscore 进入审核队列人工决定。

处理：
- rejected 且有评分且 < 阈值（6.0）→ queued + is_lowscore=True（低分可复用）
- rejected 且有评分且 ≥ 阈值 → queued（误拒恢复）
- rejected 无评分（预过滤/人工）→ 不动

用法：uv run python scripts/restore_rejected_scores.py
"""

import asyncio

from sqlalchemy import select

from backend.config import settings
from backend.models.item import Item
from backend.models.session import session_factory


async def main() -> None:
    threshold = float(getattr(settings, "pipeline_min_score", 6.0))
    restored = 0
    low_marked = 0
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(Item.status == "rejected", Item.score_total.isnot(None))
            )
        ).scalars().all()
        for item in rows:
            low = item.score_total < threshold
            item.status = "queued"
            item.is_lowscore = low
            item.error = None
            if low:
                low_marked += 1
            else:
                restored += 1
        await session.commit()
    print(f"恢复 {restored} 条误拒条目 → queued")
    print(f"恢复 {low_marked} 条低分条目 → queued + is_lowscore（低分可复用）")


if __name__ == "__main__":
    asyncio.run(main())
