"""迁移 Autarkeia 封面到 Hertz 素材目录（一次性脚本，v0.2.0）。

问题：迁移条目的 cover_path 指向 /Users/young/Code/Autarkeia/data/covers/，
超出 Hertz library 允许根（AXIOM §8.3 containment）→ 审核队列封面不可见。

方案：拷贝封面到 data/media/covers/（14MB，体积可控），更新 cover_path
为 Hertz 绝对路径（与 Hertz 自身产物格式一致）。video/raw 大文件不迁移
（1.3GB+626MB），produce 会重建成片；审核看封面足够。

用法：uv run python scripts/migrate_media_assets.py
"""

import asyncio
import shutil
from pathlib import Path

from sqlalchemy import select

from backend.config import settings
from backend.models.item import Item
from backend.models.session import session_factory

SRC_COVERS = Path.home() / "Code" / "Autarkeia" / "data" / "covers"


async def main() -> None:
    dest = (settings.data_dir / "media" / "covers").resolve()
    dest.mkdir(parents=True, exist_ok=True)
    updated = 0
    copied = 0
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(
                    Item.cover_path.isnot(None), Item.status == "queued"
                )
            )
        ).scalars().all()
        for item in rows:
            src = Path(item.cover_path)
            if not str(src).startswith(str(SRC_COVERS)):
                continue
            if not await asyncio.to_thread(src.is_file):
                continue
            target = dest / src.name
            if not target.exists():
                shutil.copy2(src, target)
                copied += 1
            item.cover_path = str(target)
            updated += 1
        await session.commit()
    print(f"拷贝 {copied} 个封面 → {dest}")
    print(f"更新 {updated} 条条目 cover_path")


if __name__ == "__main__":
    asyncio.run(main())
