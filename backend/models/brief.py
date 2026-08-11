"""Orchestration domain models: Brief (creative strategy)."""

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Brief(BaseModel):
    __tablename__ = "briefs"

    name: Mapped[str] = mapped_column(String(255))
    # Pure Markdown creative brief — the authoritative creative direction
    content: Mapped[str] = mapped_column(Text, default="")
    platform_id: Mapped[str] = mapped_column(String(64), default="")
    # Structured config: phase params, output params, publishing params
    config_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class BriefGroup(BaseModel):
    """策略组（v0.7）— 策略的集合，类比「团队 = 角色的集合」。

    角色库 → 团队：roles → crews（引用角色 key 列表）；
    策略库 → 策略组：briefs → brief_groups（引用 brief id 列表）。
    计划挂策略组时，组内策略按序拼接注入（组优先于单个 brief）。
    """

    __tablename__ = "brief_groups"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    # 组内策略 id 的有序列表（引用 briefs 表）
    brief_ids: Mapped[list] = mapped_column(JSONB, default=list)
