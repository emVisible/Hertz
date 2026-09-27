"""Monoline 融合域模型：文稿转解说视频作业库（PG 版）。

源自 monoline `db/migrations/001_init.sql`（SQLite raw SQL），移植时：
- 表名全部 `monoline_` 前缀（D-023，防与 Hertz 通用表名冲突）；
- 主键统一 UUID（BaseModel），`TEXT JSON` 字段改 JSONB；
- `segments.norm_duration` 的 GENERATED 列改 Python property（PG 生成列跨版本行为差异大）；
- `scene_plans.schema` 列名保留（API 兼容），属性名避开 SQLAlchemy 保留字用 `plan_schema`；
- `schema_version` 表不需要（Alembic 接管）。
"""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class MonolineJobStatus(StrEnum):
    DRAFT = "draft"
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MonolineStageStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class MonolineJob(BaseModel):
    __tablename__ = "monoline_jobs"

    slug: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default=MonolineJobStatus.DRAFT, index=True)
    script_text: Mapped[str] = mapped_column(Text, default="")
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    canvas: Mapped[dict] = mapped_column(JSONB, default=dict)
    total_duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    hf_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class MonolineJobStage(BaseModel):
    __tablename__ = "monoline_job_stages"
    __table_args__ = (UniqueConstraint("job_id", "key", name="uq_monoline_stage_job_key"),)

    job_id: Mapped[UUID] = mapped_column(
        ForeignKey("monoline_jobs.id", ondelete="CASCADE"), index=True
    )
    key: Mapped[str] = mapped_column(String(64))
    seq: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default=MonolineStageStatus.PENDING)
    input_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    output_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class MonolineSegment(BaseModel):
    __tablename__ = "monoline_segments"
    __table_args__ = (UniqueConstraint("job_id", "i", name="uq_monoline_segment_job_i"),)

    job_id: Mapped[UUID] = mapped_column(
        ForeignKey("monoline_jobs.id", ondelete="CASCADE"), index=True
    )
    i: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text, default="")
    line_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    wav_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    wav_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tts_duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    start: Mapped[float | None] = mapped_column(Float, nullable=True)
    end: Mapped[float | None] = mapped_column(Float, nullable=True)
    audio_source: Mapped[str] = mapped_column(String(32), default="tts")
    voice: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lang: Mapped[str | None] = mapped_column(String(16), nullable=True)
    speed: Mapped[float | None] = mapped_column(Float, nullable=True)

    @property
    def norm_duration(self) -> float | None:
        if self.start is None or self.end is None:
            return None
        return round(self.end - self.start, 3)


class MonolineScenePlan(BaseModel):
    __tablename__ = "monoline_scene_plans"

    job_id: Mapped[UUID] = mapped_column(
        ForeignKey("monoline_jobs.id", ondelete="CASCADE"), index=True
    )
    plan_schema: Mapped[str] = mapped_column("schema", String(64), default="sceneplan/v1")
    version: Mapped[int] = mapped_column(Integer, default=1)
    plan_json: Mapped[dict] = mapped_column(JSONB, default=dict)
    source: Mapped[str] = mapped_column(String(32), default="rules")
    warnings_json: Mapped[list | None] = mapped_column(JSONB, nullable=True)


class MonolineArtifact(BaseModel):
    __tablename__ = "monoline_artifacts"

    job_id: Mapped[UUID] = mapped_column(
        ForeignKey("monoline_jobs.id", ondelete="CASCADE"), index=True
    )
    stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    rel_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    abs_path: Mapped[str | None] = mapped_column(String(2048), nullable=True)
    mime: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    fps: Mapped[int | None] = mapped_column(Integer, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    state: Mapped[str] = mapped_column(String(32), default="local")


class MonolineEvent(BaseModel):
    __tablename__ = "monoline_events"
    __table_args__ = (Index("idx_monoline_events_job", "job_id", "id"),)

    job_id: Mapped[UUID] = mapped_column(ForeignKey("monoline_jobs.id", ondelete="CASCADE"))
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    kind: Mapped[str] = mapped_column(String(64))
    stage_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    level: Mapped[str] = mapped_column(String(16), default="info")
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    data_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)


class MonolinePreset(BaseModel):
    __tablename__ = "monoline_presets"

    name: Mapped[str] = mapped_column(String(255))
    config: Mapped[dict] = mapped_column(JSONB, default=dict)


class MonolineBrand(BaseModel):
    """用户级默认外观（单行表，id 固定 1 的约定的简版：取最新一行）。

    对应上游 brand.json：label/theme/accent + logo 文件名；建作业时缺省填入 config。
    """

    __tablename__ = "monoline_brand"

    label: Mapped[str] = mapped_column(String(255), default="Monoline")
    theme: Mapped[str] = mapped_column(String(64), default="mono-ink")
    accent: Mapped[str | None] = mapped_column(String(32), nullable=True)
    logo_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
