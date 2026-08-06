"""Phase store: user-maintainable phase catalog (Wave 7.3).

内置工序（builtin=True）来自代码常量，只读；用户可新增自定义 agent 工序
（LLM 驱动的 {key}.md 产物）并编辑名称/描述——工序库从此可维护。
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class PhaseStore(BaseModel):
    __tablename__ = "phases"

    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    phase_type: Mapped[str] = mapped_column(String(16), default="agent")  # agent | system
    agent_key: Mapped[str] = mapped_column(String(64), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    output_file: Mapped[str] = mapped_column(String(64), default="")
    phase_group: Mapped[str] = mapped_column(String(32), default="custom")
    timeout: Mapped[int] = mapped_column(Integer, default=300)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # 软删除：内置工序可归档（不再出现在工序库，可用 restore_defaults 恢复）
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Agent 工序的 LLM 配置（内置可编辑内容、不可删除；种子/回退到 DEFAULT_AGENTS）
    role: Mapped[str] = mapped_column(String(120), default="")
    method: Mapped[str] = mapped_column(Text, default="")
    style: Mapped[list] = mapped_column(JSONB, default=list)
    model: Mapped[str] = mapped_column(String(64), default="")
    retries: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
    )


def new_phase_key(name: str) -> str:
    """自定义工序 key：slug + 短随机（用于 {key}.md 产物文件名）。"""
    import re

    slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:24] or "phase"
    return f"{slug}_{uuid.uuid4().hex[:6]}"
