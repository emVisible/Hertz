"""看板域的写作者（v0.34 B）：每日目标 + 条目「今日关注」。

拆成三块，各自只有一个作者：

* `get_goal` / `put_goal` —— `daily_goal` 表的唯一读写口（一天一行，upsert）。
* `set_focus` —— `items.focus_date/focus_note` 的**唯一**写入口。
* `GOAL_MAX_CHARS` —— 目标文本长度上限的单点（系统边界校验，模型层不重复约束）。

为什么不塞进 `service_queries.py`：那个 Mixin 是「读条目」的作者，而这里是
「按日期 upsert 一行配置 + 写两列关注」。混在一起会让读侧顺手获得写权限，
正是本仓库一路在防的第二作者。
"""

from __future__ import annotations

from datetime import date
from uuid import UUID

from sqlalchemy import select

from backend.models.board import DailyGoal
from backend.models.item import Item
from backend.models.session import session_factory

#: 目标文本唯一长度上限（系统边界）。端点与界面都读这一个数，别处不许再写 4000。
GOAL_MAX_CHARS = 4000


def _shape(row: DailyGoal | None, day: date) -> dict:
    if row is None:
        return {"goal_date": day.isoformat(), "goal_text": "", "updated_at": None}
    return {
        "goal_date": row.goal_date.isoformat(),
        "goal_text": row.goal_text or "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


async def get_goal(day: date) -> dict:
    """取某天的目标；没有那一行时回答空文本，**不**建行（读不该有副作用）。"""
    async with session_factory() as session:
        row = (
            await session.execute(select(DailyGoal).where(DailyGoal.goal_date == day))
        ).scalar_one_or_none()
        return _shape(row, day)


async def put_goal(day: date, goal_text: str) -> dict:
    """upsert：无则建、有则改。后写覆盖、不做乐观锁——单人本地桌面应用，
    加版本号是纯成本（真多人协作时再议，别提前建）。"""
    if len(goal_text) > GOAL_MAX_CHARS:
        raise ValueError(f"goal_text 超过 {GOAL_MAX_CHARS} 字")
    async with session_factory() as session:
        row = (
            await session.execute(select(DailyGoal).where(DailyGoal.goal_date == day))
        ).scalar_one_or_none()
        if row is None:
            row = DailyGoal(goal_date=day, goal_text=goal_text)
            session.add(row)
        else:
            row.goal_text = goal_text
        await session.commit()
        await session.refresh(row)
        return _shape(row, day)


async def set_focus(
    item_id: UUID | str,
    *,
    focus_date: date | None,
    focus_note: str | None,
    touch_note: bool,
) -> dict:
    """`items.focus_*` 的唯一写入口（v0.34 B 看板）。

    `touch_note=False` 时**不碰** focus_note：这是 PATCH 的局部语义——只发
    focus_date 的客户端不该被隐式清空备注（那会被读成「我写的加工备注丢了」，
    而这类静默覆盖比报错更伤人）。

    归档条目一律拒绝（`ValueError` → 端点映射 409）：归档 = 退出工作区，
    还能 focus 就等于在异常区外面再开一条侧门。
    """
    async with session_factory() as session:
        item = await session.get(Item, UUID(str(item_id)))
        if item is None:
            raise LookupError("条目不存在")
        if item.archived:
            raise ValueError("已归档条目不能加入今日；请先取消归档")
        item.focus_date = focus_date
        if touch_note:
            item.focus_note = focus_note
        await session.commit()
        return {
            "id": str(item.id),
            "focus_date": item.focus_date.isoformat() if item.focus_date else None,
            "focus_note": item.focus_note,
        }
