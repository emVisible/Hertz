import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import DateTime, String, Text, func
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class JobStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class JobRun(BaseModel):
    __tablename__ = "job_runs"

    job_name: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default=JobStatus.RUNNING)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    summary: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class TelegramNotification(BaseModel):
    """已推送的 Telegram bot 通知（v0.18 去重：同一条目只推一次）。"""

    __tablename__ = "tg_notifications"

    item_id: Mapped[uuid.UUID] = mapped_column(
        postgresql.UUID(as_uuid=True), index=True
    )
    kind: Mapped[str] = mapped_column(String(32), default="review")
    message_id: Mapped[int] = mapped_column()
