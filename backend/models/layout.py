"""Layout 域模型：超级 Markdown 模块（MD Studio）排版稿库（设计 §6，切片 D）。

一份排版稿 = 源文 markdown + 平台（wechat/xhs/zhihu）+ 主题 + 微调 overrides +
封面 cover。后端只做 CRUD 与导入，零渲染（解析/排版/导出全部在前端 mdcore）。
`source_ref` 记录来源：docs 空间相对路径或 `studio:<run slug>`，可空（粘贴新建）。
"""

from sqlalchemy import String, Text
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
