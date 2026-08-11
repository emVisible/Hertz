"""Pipeline 域共享助手（v0.8 查漏补缺）：消除 service/engine 的重复骨架。"""

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError


async def load_item_for_action(
    item_id, allowed_statuses: tuple, action: str
) -> Item:
    """加载条目并校验状态（6+ 处重复骨架收敛）。

    不存在 → ItemNotFoundError（404）；状态不允许 → InvalidItemStateError（409）。
    返回的 Item 在调用方自己的 session 事务内使用（commit 由调用方负责）。
    """
    async with session_factory() as session:
        item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        if item.status not in allowed_statuses:
            raise InvalidItemStateError(
                f"cannot {action} item in state {item.status}"
            )
        return item


def back_status_for(item: Item) -> str:
    """回退状态机（v5.9）：有成片→scored（重制）/ 已下载→downloaded（重评分）/
    否则→discovered（重下载）。retry 与 retry_class 共用。"""
    return (
        "scored"
        if item.video_path
        else ("downloaded" if item.raw_path else "discovered")
    )
