"""wave10_publish_queue: publish queue phase on items.

'' = 不入队（纯手动发布）/ 'holding' = 预发布队列 / 'ready' = 发布队列。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave10_publish_queue"
down_revision = "wave24_story_selftext"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("queue_phase", sa.String(16), server_default="", nullable=False),
    )
    op.create_index("ix_items_queue_phase", "items", ["queue_phase"])


def downgrade() -> None:
    op.drop_index("ix_items_queue_phase", table_name="items")
    op.drop_column("items", "queue_phase")