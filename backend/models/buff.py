"""Buff（Buff 库）— 游戏化态度/话术注入（v5.0）。

Buff = 注入到 agent system prompt 的附加指令，给确定性串行流程增加可变性。

两级：
- lightweight（轻量）：纯文本效果——一句话/一段指令拼进 prompt（人情味/去AI味/语气强硬…）
- heavy（重量）：类 skill/插件——更复杂的注入或行为（本期先支持复杂多段指令，
  MCP/工具级能力留待后续）

随机：category=random 的 buff 可被 `random` 特殊 key 触发——每次运行随机抽取。
"""

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class Buff(BaseModel):
    __tablename__ = "ai_buffs"

    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    # lightweight | heavy
    kind: Mapped[str] = mapped_column(String(16), default="lightweight")
    # buff（正向：要做什么）| debuff（反向：不要做什么）——v5.2
    polarity: Mapped[str] = mapped_column(String(16), default="buff")
    # MD 格式的注入指令（拼进 system prompt；heavy 可为多段/条件指令）
    effect: Mapped[str] = mapped_column(Text, default="")
    # stable（稳定池，手动启用）| random（随机池，random buff 抽取）
    category: Mapped[str] = mapped_column(String(16), default="stable")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
