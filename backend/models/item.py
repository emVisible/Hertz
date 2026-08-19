"""Content item model — the entity flowing through the execution pipeline.

Lifecycle: discovered → downloaded → scored → queued → approved → published
（v5.9：下载在评分之前；评分/制作手动触发，半自动流水线）
Any stage may fail → failed; rejected at review.
"""

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Identity,
    Integer,
    String,
    Text,
)
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

    # 入库自增序号（v0.3.1，参考原项目 rowid 语义）：真实入库顺序——
    # 同批插入的 created_at 相同（PostgreSQL now() 为事务时间），
    # 审核「最新/最旧」排序依赖 seq 而非时间戳
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), nullable=False)

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
    # 文字帖正文（v0.11.7 情感故事产线）：text_only 帖的 selftext，null = 非文字帖
    selftext: Mapped[str | None] = mapped_column(Text, nullable=True)

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

    # 生产方式模块集合（v0.3.3，预处理人工选择）：
    # {"passthrough"|"voice"|"subtitle"|"translate"|"mute": bool}
    # 默认 voice+subtitle+translate（英文旁白 + 中文字幕，现状行为）
    produce_options: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Review / publish
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 排期发布（独立发布环节，v5.10）：定时上传用
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 发布队列（v0.12，单一真相源——语义与 publish_queue 模块常量一致）：
    #   ''      = 不入队（纯手动发布，不参与自动发布/产能）
    #   'holding' = 预发布队列：囤着待命，无排期，不自动分槽/发布
    #   'ready'   = 发布队列：必须有 scheduled_at，到点由 auto_publish tick 发布
    # 约束：ready ⇒ scheduled_at 非空；holding ⇒ scheduled_at 为空
    queue_phase: Mapped[str] = mapped_column(
        String(16), default="", server_default="", index=True
    )

    # Failure diagnostics
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 失败分类（v0.2.1）：blocked/rate_limit/timeout/llm/tts/ffmpeg/download/publish/internal/other
    error_class: Mapped[str] = mapped_column(String(32), default="", index=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)

    # Optional ownership link to an orchestration run
    run_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("workflow_runs.id", ondelete="SET NULL"), nullable=True
    )

    # 软归档（wave10）：删除入口收口异常区——归档 = 磁盘清理 + 字段清洗后标记，
    # 保留基础数据（标题/来源/评分/发布记录）作备用库；不再出现在任何流程列表
    archived: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
