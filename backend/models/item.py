"""Content item model — the entity flowing through the execution pipeline.

Lifecycle: discovered → scored → downloaded → queued → approved → published
Any stage may fail → failed; rejected at review.
"""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from backend.models.base import BaseModel


class ItemStatus(StrEnum):
    DISCOVERED = "discovered"
    SCORED = "scored"
    DOWNLOADED = "downloaded"
    QUEUED = "queued"
    APPROVED = "approved"
    PUBLISHED = "published"
    REJECTED = "rejected"
    FAILED = "failed"


class ItemType(StrEnum):
    VIDEO_RAW = "video_raw"
    IMAGE_GALLERY = "image_gallery"
    TEXT_ONLY = "text_only"


class Item(BaseModel):
    __tablename__ = "items"

    status: Mapped[str] = mapped_column(String(32), default=ItemStatus.DISCOVERED, index=True)
    item_type: Mapped[str] = mapped_column(String(32), default=ItemType.VIDEO_RAW)

    # Source provenance
    source: Mapped[str] = mapped_column(String(64), default="")
    source_url: Mapped[str] = mapped_column(Text, default="")
    media_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    source_id: Mapped[str] = mapped_column(String(255), default="")
    title: Mapped[str] = mapped_column(Text, default="")
    subreddit: Mapped[str] = mapped_column(String(128), default="")
    author: Mapped[str] = mapped_column(String(128), default="")
    reddit_score: Mapped[int] = mapped_column(Integer, default=0)
    upvote_ratio: Mapped[float] = mapped_column(Float, default=1.0)
    num_comments: Mapped[int] = mapped_column(Integer, default=0)

    # Scoring
    score_total: Mapped[float | None] = mapped_column(Float, nullable=True)
    score_dimensions: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    score_reasons: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # 低分标记（v0.2.0）：低于阈值不自动丢弃，进审核人工决定（参考原项目）
    is_lowscore: Mapped[bool] = mapped_column(Boolean, default=False)

    # Production artifacts (paths relative to data_dir)
    raw_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    video_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    subtitle_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    cover_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    script_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    publish_json: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # 产物目录名（相对 data_dir，如 pipeline/2026-08-04-01）；空 = 旧版 hex 目录
    output_dir: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Dedupe
    phash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # Review / publish
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 排期发布（独立发布环节，v5.10）：定时上传用
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Failure diagnostics
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)

    # Optional ownership link to an orchestration run
    run_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("workflow_runs.id", ondelete="SET NULL"), nullable=True
    )
