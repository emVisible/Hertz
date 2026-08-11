"""Orchestration domain models: Plan and pipeline run records."""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class PlanMode(StrEnum):
    TEXT = "text"
    VISUAL = "visual"
    VIDEO = "video"


class Plan(BaseModel):
    __tablename__ = "plans"

    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    mode: Mapped[str] = mapped_column(String(32), default=PlanMode.TEXT)
    # Ordered phase list: [{key, enabled, config}]
    phase_order: Mapped[list] = mapped_column(JSONB, default=list)

    crew_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("crews.id", ondelete="SET NULL"), nullable=True
    )
    brief_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("briefs.id", ondelete="SET NULL"), nullable=True
    )
    # 策略组（v0.7）：组优先于单个 brief——挂了组则忽略 brief_id
    brief_group_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("brief_groups.id", ondelete="SET NULL"), nullable=True
    )
    # 计划级持久 buff（v5.0）：["human_touch", "de_ai", ...]；运行时 Studio 可覆盖
    buff_keys: Mapped[list] = mapped_column(JSONB, default=list)


class WorkflowRunStatus(StrEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class WorkflowRun(BaseModel):
    __tablename__ = "workflow_runs"

    status: Mapped[str] = mapped_column(String(32), default=WorkflowRunStatus.RUNNING, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Run context: topic, brief snapshot, etc.
    context_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 产物目录（相对 output_root，如 studio/2026-08-04-01）；空 = 旧版 hex 目录
    output_dir: Mapped[str | None] = mapped_column(String(255), nullable=True)

    plan_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("plans.id", ondelete="SET NULL"), nullable=True
    )


class PhaseRunStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PhaseRun(BaseModel):
    __tablename__ = "phase_runs"

    phase_key: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default=PhaseRunStatus.PENDING)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Phase output: text, file paths, structured results
    output_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    run_id: Mapped[UUID] = mapped_column(ForeignKey("workflow_runs.id", ondelete="CASCADE"))
