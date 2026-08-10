"""wave21_produce_templates: 生产方式预设模板（v0.4 B3）。

命名组合（直发/配音+字幕/…）一键套用批量生产方式。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave21_produce_templates"
down_revision = "wave20_depth_levels"


def upgrade() -> None:
    op.create_table(
        "produce_templates",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("options_json", sa.Text(), nullable=True),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
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


def downgrade() -> None:
    op.drop_table("produce_templates")
