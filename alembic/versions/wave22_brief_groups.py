"""wave22_brief_groups: 策略组（v0.7）——策略的集合（类比团队=角色集合）。

新表 brief_groups + plans.brief_group_id（组优先于单个 brief）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave22_brief_groups"
down_revision = "wave21_produce_templates"


def upgrade() -> None:
    op.create_table(
        "brief_groups",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("brief_ids", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.add_column("plans", sa.Column("brief_group_id", sa.Uuid(), nullable=True))


def downgrade() -> None:
    op.drop_column("plans", "brief_group_id")
    op.drop_table("brief_groups")
