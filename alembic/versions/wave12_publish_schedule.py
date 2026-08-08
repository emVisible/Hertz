"""wave12_publish_schedule: items 加 scheduled_at（排期发布，v5.10）。

发布是独立人工环节（非流水线链路）：审核通过后进入发布 menu，
可设排期（scheduled_at）后定时发布，或立即/自制发布。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave12_publish_schedule"
down_revision = "wave11_model_fetch_cache"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("items", "scheduled_at")
