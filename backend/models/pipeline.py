"""Execution-domain model: per-source collection state.

The JobRun audit trail lives in backend.models.system (job_runs table).
"""

import json
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class SourceState(BaseModel):
    """Per-(source, channel) cursor and failure bookkeeping.

    Cursor enables incremental collection (only fetch NEW posts since the
    last run); cooldowns back off failing endpoints. UNIQUE on (source, channel).
    """

    __tablename__ = "source_state"
    __table_args__ = (UniqueConstraint("source", "channel"),)

    source: Mapped[str] = mapped_column(String(64), index=True)
    channel: Mapped[str] = mapped_column(String(128), index=True)
    cursor_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    cooldowns_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    ok_count: Mapped[int] = mapped_column(Integer, default=0)
    fail_count: Mapped[int] = mapped_column(Integer, default=0)
    # 数据源健康度（v0.2.1，参考原项目）：连续失败 + 最后错误 → dead/degraded/healthy
    consecutive_fails: Mapped[int] = mapped_column(Integer, default=0)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_error_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_strategy: Mapped[str | None] = mapped_column(String(32), nullable=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    def get_cursor(self) -> dict:
        if not self.cursor_json:
            return {}
        try:
            data = json.loads(self.cursor_json)
            return data if isinstance(data, dict) else {}
        except ValueError:
            return {}

    def set_cursor(self, cursor: dict) -> None:
        self.cursor_json = json.dumps(cursor, ensure_ascii=False)

    def get_cooldowns(self) -> dict[str, float]:
        if not self.cooldowns_json:
            return {}
        try:
            data = json.loads(self.cooldowns_json)
            return {str(k): float(v) for k, v in data.items()} if isinstance(data, dict) else {}
        except (ValueError, TypeError):
            return {}

    def set_cooldowns(self, cooldowns: dict[str, float]) -> None:
        self.cooldowns_json = json.dumps(cooldowns)


class ResourceCooldown(BaseModel):
    """媒体资源冷却（v0.3.6 冰川式，参考原项目 CDN 熔断扩展）。

    采集失败冷却记在 SourceState；下载失败按**媒体域**冻结——期间跳过该域
    全部下载（条目保持 discovered 不 FAILED），避免反复打被封锁的 CDN。
    指数退避落库持久（重启不丢）；域内任一下载成功即解冻。
    """

    __tablename__ = "resource_cooldown"

    domain: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    fail_level: Mapped[int] = mapped_column(Integer, default=1)
    until_epoch: Mapped[float] = mapped_column(Float, default=0.0)


class ProduceTemplate(BaseModel):
    """生产方式预设模板（v0.4 B3）：命名组合一键套用批量生产方式。

    内置四模板以代码为准（seed 同步）；用户可增改自定义模板。
    options_json = 生产方式模块组合（passthrough/voice/subtitle/translate/mute）。
    """

    __tablename__ = "produce_templates"

    name: Mapped[str] = mapped_column(String(120))
    options_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
