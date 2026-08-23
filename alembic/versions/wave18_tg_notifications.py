"""wave18_tg_notifications: Telegram bot 通知去重表（v0.18）。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "wave18_tg_notifications"
down_revision = "wave15_glossary"


def upgrade() -> None:
    op.create_table(
        "tg_notifications",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("item_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("kind", sa.String(32), nullable=False, server_default="review"),
        sa.Column("message_id", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("tg_notifications")
