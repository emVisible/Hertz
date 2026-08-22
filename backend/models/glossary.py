"""翻译术语表（v0.15）：VideoLingo 精华借鉴——术语统一是字幕质量的地基。

source_term → target_term 强制映射；translate prompt 注入启用中的条目，
保证人名/品牌/专有名词跨视频一致（如 Mr.Beast → 野兽先生）。
"""

from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class GlossaryTerm(BaseModel):
    __tablename__ = "glossary_terms"

    # 原文唯一——重复添加同一术语走更新而非新增（§8.1 幂等语义）
    source_term: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    target_term: Mapped[str] = mapped_column(String(120))
    # 可选分类：person / brand / term（前端筛选用，不参与注入逻辑）
    domain: Mapped[str] = mapped_column(String(32), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
