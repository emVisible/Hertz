"""迁移 Autarkeia 媒体到 Hertz 数据根（一次性脚本，v0.2.5）。

问题：迁移条目的 video_path 指向 /Users/young/Code/Autarkeia/data/output/，
超出 Hertz library 允许根（AXIOM §8.3 containment）→ 审核卡点击播放 403，
即使文件在系统上存在。

方案：硬链接（同卷秒建，零拷贝）优先，跨卷回退复制——视频/封面归位到
data/media/{videos,covers}/，更新 items.video_path / cover_path。
幂等：目标已存在则跳过；非 Autarkeia 路径不动。

用法：uv run python scripts/migrate_autarkeia_media.py
"""

import asyncio
import shutil
from pathlib import Path

from sqlalchemy import select

from backend.config import settings
from backend.infrastructure.storage import file_store
from backend.models.item import Item
from backend.models.session import session_factory

SRC_VIDEOS = Path.home() / "Code" / "Autarkeia" / "data" / "output"
SRC_COVERS = Path.home() / "Code" / "Autarkeia" / "data" / "covers"


def _link_or_copy(src: Path, dest: Path) -> str:
    """硬链接优先（同卷零拷贝），跨卷回退复制。返回产物说明。"""
    if dest.exists():
        return "skip(exists)"
    try:
        dest.hardlink_to(src)
        return "hardlink"
    except OSError:
        shutil.copy2(src, dest)
        return "copy"


async def main() -> None:
    # 注意：file_store.resolve 已锚定 data_dir——传相对路径，勿再拼 data_dir 前缀
    videos_dir = file_store.resolve(Path("media/videos"))
    covers_dir = file_store.resolve(Path("media/covers"))
    videos_dir.mkdir(parents=True, exist_ok=True)
    covers_dir.mkdir(parents=True, exist_ok=True)

    moved_video = moved_cover = 0
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(
                    (Item.video_path.isnot(None) & (Item.video_path != ""))
                    | (Item.cover_path.isnot(None) & (Item.cover_path != ""))
                )
            )
        ).scalars().all()
        for item in rows:
            for field, src_root, dest_dir in (
                ("video_path", SRC_VIDEOS, videos_dir),
                ("cover_path", SRC_COVERS, covers_dir),
            ):
                raw = getattr(item, field)
                if not raw:
                    continue
                src = Path(raw)
                if not str(src).startswith(str(src_root)):
                    continue  # 非 Autarkeia 路径不动（Hertz 自身产物等）
                if not src.is_file():
                    print(f"跳过（源文件不存在）: {src}")
                    continue
                dest = dest_dir / src.name
                how = await asyncio.to_thread(_link_or_copy, src, dest)
                if how != "skip(exists)":
                    setattr(item, field, str(dest))
                    if field == "video_path":
                        moved_video += 1
                    else:
                        moved_cover += 1
                    print(f"[{field}] {how}: {src.name}")
        await session.commit()
    print(f"\n迁移完成：video {moved_video} 条、cover {moved_cover} 条 → {settings.data_dir / 'media'}")


if __name__ == "__main__":
    asyncio.run(main())
