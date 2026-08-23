"""wave19_channel_insights: 频道洞察快照表（v0.19 数据飞轮一期）。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "wave19_channel_insights"
down_revision = "wave18_tg_notifications"


def upgrade() -> None:
    op.create_table(
        "channel_insights",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("insights_json", postgresql.JSONB(), nullable=False),
        sa.Column("source_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("channel_insights")
