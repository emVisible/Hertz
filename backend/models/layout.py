"""Layout 域模型：超级 Markdown 模块（MD Studio）排版稿库（设计 §6，切片 D）。

一份排版稿 = 源文 markdown + 平台（wechat/xhs/zhihu）+ 主题 + 微调 overrides +
封面 cover。后端只做 CRUD 与导入，零渲染（解析/排版/导出全部在前端 mdcore）。
`source_ref` 记录来源：docs 空间相对路径或 `studio:<run slug>`，可空（粘贴新建）。
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Layout(BaseModel):
    __tablename__ = "layouts"

    title: Mapped[str] = mapped_column(String(255), default="")
    source_md: Mapped[str] = mapped_column(Text, default="")
    source_ref: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    platform: Mapped[str] = mapped_column(String(16), default="wechat")
    theme_id: Mapped[str] = mapped_column(String(128), default="")
    overrides: Mapped[dict] = mapped_column(JSONB, default=dict)
    cover: Mapped[dict] = mapped_column(JSONB, default=dict)
    # 软删时间戳（W2 回收站）：NULL = 活着。用时间戳而不是布尔，是为了让"什么时候删的"
    # 可回答；布尔只有一个"是/否"，而布尔软删最常见的失效是被忘掉置位。
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LayoutRevision(BaseModel):
    """排版稿的整份快照（W2 版本历史）。

    存整份而不是 diff：diff 要重建中间态，而排版稿体积（几十 KB 文本）对单用户
    桌面应用完全可接受；换来的是"能直接回到任意历史版本"。
    撤销/重做在内存里做（前端 draftHistory），这张表负责**跨会话**。
    """

    __tablename__ = "layout_revisions"

    layout_id: Mapped[UUID] = mapped_column(ForeignKey("layouts.id", ondelete="CASCADE"))
    # 该稿内的递增序号：查询"最近 N 版"直接 ORDER BY seq DESC LIMIT N，
    # 不必按时间戳猜（时间戳可能撞）
    seq: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(255), default="")
    source_md: Mapped[str] = mapped_column(Text, default="")
    source_ref: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    platform: Mapped[str] = mapped_column(String(16), default="wechat")
    theme_id: Mapped[str] = mapped_column(String(128), default="")
    overrides: Mapped[dict] = mapped_column(JSONB, default=dict)
    cover: Mapped[dict] = mapped_column(JSONB, default=dict)
