"""monoline fusion tables: 文稿转视频作业库 7 张表（只加表，不碰旧表）。

源自 monoline `db/migrations/001_init.sql` 的 PG 化（见 backend/models/monoline.py）：
- 表名 `monoline_` 前缀；主键 UUID；JSON 字段 JSONB；
- `down_revision` 挂主线 head（wave27），wave21 悬空 head 保持不动（沿用多 head 惯例）。
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "wave28_monoline_tables"
down_revision = "wave27_plan_brief_group_fk"


def upgrade() -> None:
    op.create_table(
        "monoline_jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("slug", sa.String(length=255), nullable=True),
        sa.Column("title", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("script_text", sa.Text(), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("canvas", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("total_duration", sa.Float(), nullable=True),
        sa.Column("hf_version", sa.String(length=32), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_monoline_jobs_slug", "monoline_jobs", ["slug"], unique=False)
    op.create_index("ix_monoline_jobs_status", "monoline_jobs", ["status"], unique=False)

    op.create_table(
        "monoline_job_stages",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("input_hash", sa.String(length=128), nullable=True),
        sa.Column("output_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["monoline_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "key", name="uq_monoline_stage_job_key"),
    )
    op.create_index("ix_monoline_job_stages_job_id", "monoline_job_stages", ["job_id"], unique=False)

    op.create_table(
        "monoline_segments",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("i", sa.Integer(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("line_no", sa.Integer(), nullable=True),
        sa.Column("wav_path", sa.String(length=1024), nullable=True),
        sa.Column("wav_bytes", sa.Integer(), nullable=True),
        sa.Column("tts_duration", sa.Float(), nullable=True),
        sa.Column("start", sa.Float(), nullable=True),
        sa.Column("end", sa.Float(), nullable=True),
        sa.Column("audio_source", sa.String(length=32), nullable=False),
        sa.Column("voice", sa.String(length=128), nullable=True),
        sa.Column("lang", sa.String(length=16), nullable=True),
        sa.Column("speed", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["monoline_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("job_id", "i", name="uq_monoline_segment_job_i"),
    )
    op.create_index("ix_monoline_segments_job_id", "monoline_segments", ["job_id"], unique=False)

    op.create_table(
        "monoline_scene_plans",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("schema", sa.String(length=64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("plan_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("warnings_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["monoline_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_monoline_scene_plans_job_id", "monoline_scene_plans", ["job_id"], unique=False)

    op.create_table(
        "monoline_artifacts",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("stage_key", sa.String(length=64), nullable=True),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("rel_path", sa.String(length=1024), nullable=True),
        sa.Column("abs_path", sa.String(length=2048), nullable=True),
        sa.Column("mime", sa.String(length=128), nullable=True),
        sa.Column("size_bytes", sa.Integer(), nullable=True),
        sa.Column("sha256", sa.String(length=64), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.Column("fps", sa.Integer(), nullable=True),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("state", sa.String(length=32), nullable=False),
        sa.ForeignKeyConstraint(["job_id"], ["monoline_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_monoline_artifacts_job_id", "monoline_artifacts", ["job_id"], unique=False)
    op.create_index("ix_monoline_artifacts_kind", "monoline_artifacts", ["kind"], unique=False)

    op.create_table(
        "monoline_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("stage_key", sa.String(length=64), nullable=True),
        sa.Column("level", sa.String(length=16), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("data_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.ForeignKeyConstraint(["job_id"], ["monoline_jobs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_monoline_events_job", "monoline_events", ["job_id", "id"], unique=False)

    op.create_table(
        "monoline_presets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("monoline_presets")
    op.drop_index("idx_monoline_events_job", table_name="monoline_events")
    op.drop_table("monoline_events")
    op.drop_index("ix_monoline_artifacts_kind", table_name="monoline_artifacts")
    op.drop_index("ix_monoline_artifacts_job_id", table_name="monoline_artifacts")
    op.drop_table("monoline_artifacts")
    op.drop_index("ix_monoline_scene_plans_job_id", table_name="monoline_scene_plans")
    op.drop_table("monoline_scene_plans")
    op.drop_index("ix_monoline_segments_job_id", table_name="monoline_segments")
    op.drop_table("monoline_segments")
    op.drop_index("ix_monoline_job_stages_job_id", table_name="monoline_job_stages")
    op.drop_table("monoline_job_stages")
    op.drop_index("ix_monoline_jobs_status", table_name="monoline_jobs")
    op.drop_index("ix_monoline_jobs_slug", table_name="monoline_jobs")
    op.drop_table("monoline_jobs")
