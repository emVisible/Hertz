"""迁移脚本（v0.8.8）：修复 gallery 多图帖被误标为 video_raw。

背景：JSON 通道 _to_post 的 url 字段对多图帖是 reddit.com/gallery/{post_id}——
classify_media 无 gallery 识别，fallback 成 video_raw（误标视频）。

修复：item_type: video_raw → image_gallery（media_url 保持 gallery 页链接，
下载由 yt-dlp 解析多图；preview 反查需认证 API，匿名不可用）。幂等。

用法：uv run python scripts/migrate_gallery_item_type.py
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select, update

from backend.models.item import Item
from backend.models.session import session_factory


async def main() -> None:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.id).where(
                    Item.item_type == "video_raw",
                    Item.media_url.like("%reddit.com/gallery/%"),
                )
            )
        ).scalars().all()
        if not rows:
            print("无 gallery 误标数据")
            return
        result = await session.execute(
            update(Item)
            .where(Item.id.in_(rows))
            .values(item_type="image_gallery")
        )
        await session.commit()
        print(f"修复 {result.rowcount} 条：gallery 帖 video_raw → image_gallery")


if __name__ == "__main__":
    asyncio.run(main())
