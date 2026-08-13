"""迁移脚本（v0.8.8）：修复 RSS 通道产生的无效 comments 链接。

背景：_rss_to_post 的 v0.8.1 归一化逻辑在 RSS link 指向 v.redd.it 时，
用媒体 ID（13 位，如 5wtt65kshxdh1）构造 `www.reddit.com/comments/{id}/`——
媒体 ID ≠ 帖子 ID（帖子 ID 为 6-8 位 base36），构造链接 404。
实测 v.redd.it/{id} 302 → https://www.reddit.com/video/{id}/（有效视频页）。

修复：source_url 由无效 comments 链接迁移为 /video/{id}/（可访问），
media_url/source_id 不变（下载链路不受影响）。

匹配规则：https://www.reddit.com/comments/{10+位ID}/（无 /r/ 路径）——
正常帖子 ID 6-8 位，坏数据均为 10+ 位媒体 ID。幂等。

用法：uv run python scripts/migrate_reddit_video_urls.py
"""

from __future__ import annotations

import asyncio
import re

from sqlalchemy import select, update

from backend.models.item import Item
from backend.models.session import session_factory

_BAD_RE = re.compile(r"^https://www\.reddit\.com/comments/([a-z0-9]{10,})/$")


async def main() -> None:
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.id, Item.source_url).where(
                    Item.source_url.like("https://www.reddit.com/comments/%"),
                    ~Item.source_url.like("https://www.reddit.com/r/%"),
                )
            )
        ).all()
        if not rows:
            print("无坏数据")
            return
        fixed = 0
        for item_id, url in rows:
            m = _BAD_RE.match(url or "")
            if not m:
                continue
            vid = m.group(1)
            await session.execute(
                update(Item)
                .where(Item.id == item_id)
                .values(source_url=f"https://www.reddit.com/video/{vid}/")
            )
            fixed += 1
        await session.commit()
        print(f"修复 {fixed}/{len(rows)} 条：comments/{{媒体ID}} → video/{{媒体ID}}")


if __name__ == "__main__":
    asyncio.run(main())
