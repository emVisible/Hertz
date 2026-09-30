"""看板域（v0.34 B）：每日目标一行 + 条目级「今天做它 / 备注怎么加工」。

命名说明（不是随口起的）：`backend/models/plan.py` 已存在且属于**编排域**
（`plans` / `Plan` / `WorkflowRun` / `PhaseRun`）。本文件的「每日目标」在 spec 早期
叫 `daily_plan`——同一仓库里两个「plan」迟早漂成两套读法，正是 D-205/D-212 在消灭的
形状，所以表叫 `daily_goal`、模型放 `board.py`、服务放 `pipeline/board_store.py`。

为什么不并进 `briefs`：briefs 是创作策略（可复用的「怎么拍」），`daily_goal` 是
运营节奏（按日期唯一的「今天做什么」）。同一张表表示两种含义，读法迟早分叉。
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import Date, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class DailyGoal(BaseModel):
    __tablename__ = "daily_goal"

    #: 用户墙上日期（前端算好 YYYY-MM-DD 下发；后端不猜时区，见 spec §4.1）。
    #: unique = 一天一行的身份；index = 查询恒为「按日期取一行」，选择性极高。
    goal_date: Mapped[date] = mapped_column(Date, unique=True, index=True)
    #: 自由多行文字。长度上限（4000）由 `board_store.GOAL_MAX_CHARS` 在 API 边界
    #: 单点校验——模型里再来一个 length 约束就是第二个判据作者。
    goal_text: Mapped[str] = mapped_column(Text, default="")
