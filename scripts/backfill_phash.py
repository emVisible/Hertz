"""v0.2.1 phash 批量回填（一次性脚本）：为存量已成片的条目计算平均哈希。

发布去重闸门依赖 item.phash；历史条目（phash 为空）补算后即可参与查重。

用法：uv run python scripts/backfill_phash.py
"""

import asyncio
import logging

from sqlalchemy import select

from backend.factory.registry import ServiceRegistry
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.phash import compute_phash


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    registry = ServiceRegistry.get()
    files = registry.files
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(
                    Item.video_path.isnot(None),
                    (Item.phash.is_(None)) | (Item.phash == ""),
                )
            )
        ).scalars().all()
    done = skipped = failed = 0
    for item in rows:
        path = files.resolve(item.video_path)
        if path is None or not path.exists():
            skipped += 1
            continue
        phash = await compute_phash(str(path))
        if not phash:
            failed += 1
            continue
        async with session_factory() as session:
            row = await session.get(Item, item.id)
            if row is not None:
                row.phash = phash
                await session.merge(row)
                await session.commit()
        done += 1
        print(f"{item.id} {item.status}: {phash} {item.video_path}")
    print(f"done={done} skipped_missing={skipped} failed={failed}")


if __name__ == "__main__":
    asyncio.run(main())
