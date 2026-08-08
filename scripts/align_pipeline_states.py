"""v5.9 状态机顺序修正（一次性脚本）。

旧流程 collect→score→download→produce 迁移后遗留的异常组合：
- scored 且无 raw_path：旧流程已评分但未下载——新流程（download→score）中
  无任何步骤消费 scored，修正为 discovered 重新走下载→评分链；
- scored 且有 raw_path：降为 downloaded（已下载待评分）。

用法：uv run python scripts/align_pipeline_states.py
"""

import asyncio

from sqlalchemy import select

from backend.models.item import Item
from backend.models.session import session_factory


async def main() -> None:
    fixed = 0
    async with session_factory() as session:
        rows = (await session.execute(select(Item).where(Item.status == "scored"))).scalars().all()
        for item in rows:
            target = "downloaded" if item.raw_path else "discovered"
            note = f"（raw_path={item.raw_path!r}）" if item.raw_path else ""
            print(f"  {item.source_id}: scored → {target} {note}".rstrip())
            item.status = target
            fixed += 1
        await session.commit()
    print(f"修正 {fixed} 条 scored 条目")


if __name__ == "__main__":
    asyncio.run(main())
