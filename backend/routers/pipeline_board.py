"""看板域端点（v0.34 B）：每日目标 + 今日关注 + 看板编排。

前缀按本仓约定 `/pipeline`（`/api` 由 app 挂载时统一加）。条目取数仍走
`ServiceRegistry.get().pipeline.list_items`（与 `pipeline_items` 同一个拿法），
本模块不写 SQL、不定义筛选条件；每日目标与关注是 `board_store` 的一次本地读写。

三条约定：
* 日期一律 `YYYY-MM-DD` 字符串由前端算好下发（后端不猜时区，见 spec §4.1）；
* 判据不在这里：目标长度、隔离清标、条目读法各自有唯一作者，端点只搬运；
* 每日目标**不自动联网**、不触发采集：它是一次本地读写。
"""

from __future__ import annotations

from datetime import date
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry
from backend.pipeline import board, board_store
from backend.pipeline.service_queries import utc_instant

router = APIRouter(prefix="/pipeline", tags=["pipeline-board"])


def _pipe():
    """与 `pipeline_items` 同一个服务拿法：条目取数的作者始终是 PipelineService。"""
    return ServiceRegistry.get().pipeline


class GoalBody(BaseModel):
    goal_text: str = Field(default="", max_length=board_store.GOAL_MAX_CHARS)


class FocusBody(BaseModel):
    focus_date: date | None = None
    focus_note: str | None = None


@router.get("/board")
async def get_board(
    day: Annotated[date, Query(alias="date")],
    published_from: Annotated[str, Query(alias="from")],
    published_to: Annotated[str, Query(alias="to")],
) -> dict:
    """看板编排：五个列 + 每列截断前计数 + 今日完成度 + 当天目标文本。

    区间 `from`/`to` 由前端算好下发（spec §4.1：后端不猜时区），这里只归一化成
    UTC ISO 再交给 `list_items`——**分列与查询用同一串**，否则「SQL 筛了一个区间、
    界面按另一个区间分列」会造出一个自相矛盾的看板。

    每列各查一次而不是「一次全量再分列」：`list_items` 的排序是入库序，一次大
    `limit` 会让积压的那一列把别的列挤出去（计数偏小且看不出来）。分列规则本身
    仍只有一个作者（`board.build_columns`），它负责把重叠捞取解析成一条一列。
    """
    from_iso = utc_instant(published_from).isoformat()
    to_iso = utc_instant(published_to).isoformat()
    day_str = day.isoformat()
    queries = (
        {"focus_date": day_str, "limit": board.COLUMN_LIMITS["focus"]},
        {
            "status": ",".join(board.IN_WORK_STATUSES),
            "limit": board.COLUMN_LIMITS["in_work"],
        },
        {"status": "queued", "limit": board.COLUMN_LIMITS["review"]},
        {"status": "approved", "limit": board.COLUMN_LIMITS["ready_to_publish"]},
        {
            "status": "published",
            "published_from": from_iso,
            "published_to": to_iso,
            "limit": board.COLUMN_LIMITS["published_today"],
        },
    )
    rows: list[dict] = []
    for kwargs in queries:
        rows.extend(await _pipe().list_items(**kwargs))
    parts = board.build_columns(rows, day_str, from_iso, to_iso)
    goal = await board_store.get_goal(day)
    return {
        "date": day_str,
        "published_from": from_iso,
        "published_to": to_iso,
        "goal_text": goal["goal_text"],
        "goal_updated_at": goal["updated_at"],
        # 长期清单沿用时给界面一句「沿自哪天」（D-220）；今天自己写过的话是 null
        "goal_carried_from": goal["carried_from"],
        **parts,
    }


@router.get("/goal/{day}")
async def get_goal(day: date) -> dict:
    """某天的待办清单。那天没有行时沿用最近一份（`carried_from` 说明是哪天），仍不建行。"""
    return await board_store.get_goal(day)


@router.put("/goal/{day}")
async def put_goal(day: date, body: GoalBody) -> dict:
    try:
        return await board_store.put_goal(day, body.goal_text)
    except ValueError as exc:  # 长度上限由 board_store 判定，这里只映射状态码
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/items/{item_id}/focus")
async def patch_focus(item_id: UUID, body: FocusBody) -> dict:
    """今日关注（捞进哪天 + 加工备注）的唯一写入口。

    `focus_note` 是否参与写，看请求体里有没有出现过这个 key —— 局部 PATCH 的
    语义判据在此一处，`board_store.set_focus` 只接受算好的 `touch_note`。
    """
    touched = "focus_note" in body.model_fields_set
    try:
        return await board_store.set_focus(
            item_id, focus_date=body.focus_date, focus_note=body.focus_note, touch_note=touched
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
