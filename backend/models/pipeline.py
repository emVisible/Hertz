"""Execution-domain model: per-source collection state.

The JobRun audit trail lives in backend.models.system (job_runs table).
"""

import json
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
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
