"""Wave 4 execution domain: item source metadata + source_state table.

Revision ID: wave4_pipeline
Revises: wave3_orchestration
Create Date: 2026-08-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "wave4_pipeline"
down_revision: str | None = "wave3_orchestration"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    item_cols = {c["name"] for c in inspector.get_columns("items")}
    new_cols = {
        "author": sa.Column("author", sa.String(128), server_default="", nullable=False),
        "reddit_score": sa.Column("reddit_score", sa.Integer(), server_default="0", nullable=False),
        "upvote_ratio": sa.Column("upvote_ratio", sa.Float(), server_default="1.0", nullable=False),
        "num_comments": sa.Column("num_comments", sa.Integer(), server_default="0", nullable=False),
    }
    for name, column in new_cols.items():
        if name not in item_cols:
            op.add_column("items", column)
    if "source_state" not in {t for t in inspector.get_table_names()}:
        op.create_table(
            "source_state",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
            sa.Column("source", sa.String(64), nullable=False),
            sa.Column("channel", sa.String(128), nullable=False),
            sa.Column("cursor_json", sa.Text(), nullable=True),
            sa.Column("cooldowns_json", sa.Text(), nullable=True),
            sa.Column("ok_count", sa.Integer(), server_default="0", nullable=False),
            sa.Column("fail_count", sa.Integer(), server_default="0", nullable=False),
            sa.Column("last_strategy", sa.String(32), nullable=True),
            sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("source", "channel"),
        )
        op.create_index("ix_source_state_source", "source_state", ["source"])
        op.create_index("ix_source_state_channel", "source_state", ["channel"])


def downgrade() -> None:
    op.drop_index("ix_source_state_channel", table_name="source_state")
    op.drop_index("ix_source_state_source", table_name="source_state")
    op.drop_table("source_state")
    op.drop_column("items", "num_comments")
    op.drop_column("items", "upvote_ratio")
    op.drop_column("items", "reddit_score")
    op.drop_column("items", "author")
