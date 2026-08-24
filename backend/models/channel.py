"""栏目实体（v0.22 栏目化内容工厂）。

栏目 = 内容包装的绑定单元：源池 × 音色 × 分区 × 简介/标签模板 ×
标题风格 × 人设 prompt × 片头配置。条目经 collect 时按 source_pool
匹配打上 channel_key，制作/发布链据此取栏目配置。

非破坏性（D-186 三律）：空表 = 系统与 v0.21 行为完全等价；未绑定
栏目的条目走原逻辑，存量条目零回写。
"""

import uuid

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Channel(BaseModel):
    __tablename__ = "channels"

    public_id: Mapped[str] = mapped_column(
        String(64), unique=True, default=lambda: uuid.uuid4().hex[:12]
    )
    name: Mapped[str] = mapped_column(String(64))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # 归属该栏目的采集通道（如 ["ai-story/情感夜话", "reddit/shortwholesome"]）
    source_pool: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 固定音色（edge-tts voice id）；空 = 走原内容自适应链
    voice: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # B 站分区 tid（发布时覆盖默认）
    bili_tid: Mapped[int | None] = mapped_column(Integer, nullable=True)
    desc_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    tags: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    title_style_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    persona_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 片头配置（动态标题卡）：{"enabled": true, "duration_s": 3, "subtitle": "..."}
    intro_config: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    def intro_enabled(self) -> bool:
        return bool((self.intro_config or {}).get("enabled"))
