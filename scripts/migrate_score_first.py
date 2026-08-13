"""迁移脚本（v0.8.6 评分先行流程重排）：存量 scored → downloaded。

旧流程（v5.9）：download → score（discovered→downloaded→scored→queued）
- downloaded = 已下载未评分
- scored = 已评分已下载

新流程（v0.8.6）：score → download（discovered→scored→downloaded→queued）
- scored = 已评分未下载（download 步骤消费）
- downloaded = 已下载未加工（produce 步骤消费）

存量数据语义换算：
- scored（已评分已下载）→ downloaded（已下载未加工，produce 可直接消费）
- downloaded（已下载未评分）→ 保持 downloaded（produce 可消费；
  评分维度缺失可通过预处理「评分」按钮补，或直接制作）
- discovered 不变（新语义=未评分，score 步骤消费）

用法：uv run python scripts/migrate_score_first.py
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select, update

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory


async def main() -> None:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.id).where(Item.status == ItemStatus.SCORED)
            )
        ).scalars().all()
        if not rows:
            print("无 scored 条目，无需迁移")
            return
        result = await session.execute(
            update(Item)
            .where(Item.status == ItemStatus.SCORED)
            .values(status=ItemStatus.DOWNLOADED)
        )
        await session.commit()
        print(f"迁移完成：{result.rowcount} 条 scored → downloaded")


if __name__ == "__main__":
    asyncio.run(main())
