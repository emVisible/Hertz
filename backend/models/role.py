"""Role（角色库）— 内容型角色实体（v4.1 简化）。

角色 = 一个 Markdown 文档实体：角色名/扮演名 + MD 说明（人读的人设与方法论）。
执行配置（method/style/model/timeout/retries）归工序库与编排层管理——
角色只表达"这个角色是谁"，不表达"怎么执行"（AXIOM §2.1 职责分离）。
"""

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Role(BaseModel):
    __tablename__ = "roles"

    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    # 角色扮演名（如 创意总监）
    role_name: Mapped[str] = mapped_column(String(120), default="")
    # MD 格式的角色说明（双栏渲染预览）——方法/风格等写在这里
    description: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
