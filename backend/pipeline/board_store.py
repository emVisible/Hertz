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


def _shape(row: DailyGoal | None, day: date, carried_from: str | None = None) -> dict:
    if row is None:
        return {
            "goal_date": day.isoformat(),
            "goal_text": "",
            "updated_at": None,
            "carried_from": None,
        }
    return {
        # 日期回的是**被问的那一天**：抄来的那份也代表今天该做什么，
        # 而来源由 `carried_from` 单独说——把源日期塞进 `goal_date` 会让界面以为
        # 「今天已经有行了」，第一次保存就会写到别的日期上去。
        "goal_date": day.isoformat(),
        "goal_text": row.goal_text or "",
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "carried_from": carried_from,
    }


async def get_goal(day: date) -> dict:
    """取某天的待办清单。

    长期一份、每天重写这件事用户否掉了（D-220）：「这个待办基本上是一段时间或者很长
    一段时间我才需要修改一次……我每次保存就几乎等于永久保存，每天都是这个任务」。
    所以那天没有行时**沿用不超过那天的最近一份**，仍然不建行。

    两件刻意不做的事：
    * **不在这里洗勾选**。后端只回答"抄哪一份"和"这是抄来的"；一行怎么算勾着、取消勾选
      长什么样，判据只有一个作者（`frontend/src/core/goalChecklist.ts`）。在这儿再实现
      一遍 `- [x]`，两边就会漂成两套勾选语义。
    * **不往后抄**。查未来那天不该拿到今天的清单，所以条件是 `goal_date <= day`。
    """
    async with session_factory() as session:
        row = (
            await session.execute(select(DailyGoal).where(DailyGoal.goal_date == day))
        ).scalar_one_or_none()
        if row is not None:
            return _shape(row, day)
        prior = (
            await session.execute(
                select(DailyGoal)
                .where(DailyGoal.goal_date <= day)
                .order_by(DailyGoal.goal_date.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if prior is None:
            return _shape(None, day)
        return _shape(prior, day, carried_from=prior.goal_date.isoformat())


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


def clear_focus(item) -> bool:
    """条目退出工作区时清掉 `focus_date` / `focus_note`——**清**的判据与 `set_focus` 同源。

    为什么需要它（而不是让三条 transition 各自 `item.focus_date = None`）：那样「清」
    就有了三个作者，而 spec §4.6 的体检第 8 条要抓的正是「绕过写入口的那条路径」——
    判据散成三处之后就没有判据可对了。

    为什么这三处必须清：`focus_date` 非空但条目已归档 / 已拒 / 已发，意思是「库里还有人
    把它当今天的活儿」。不在这儿清，第 8 条就会在**正常操作**上变红，等于新造一条
    长期红的报警器（v0.34 C 刚消灭过同一种形状）。

    收实例而不是 id：调用方已经把行装载在自己的 session 里，这里只改字段、不 commit，
    提交时机仍归调用方（`set_focus` 才是那个自己开 session 的写入口）。
    """
    if getattr(item, "focus_date", None) is None and getattr(item, "focus_note", None) is None:
        return False
    item.focus_date = None
    item.focus_note = None
    return True


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
