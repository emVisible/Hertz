"""Orchestration domain models: Team（团队）— 角色的集合（v4.0 重构）。

概念：角色 = 独立实体（roles 表）；团队 = 角色 key 的有序列表。
计划关联团队；引擎从团队的角色 key → 角色库查配置。
表名保留 crews（迁移兼容），语义为"团队"。
"""

from sqlalchemy import String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Crew(BaseModel):
    __tablename__ = "crews"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    # 团队 = 角色 key 的有序列表：["director", "writer", ...]
    # 角色配置在 roles 表；此字段只存引用（v4.0 起，旧数据经迁移转换）
    agents: Mapped[list] = mapped_column(JSONB, default=list)
