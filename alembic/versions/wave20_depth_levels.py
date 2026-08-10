"""wave20_depth_levels: 输出深度档位库（v0.3.10 可维护化）。

Studio 编排「深度」从代码常量变为可维护的 DB 档位（ai_depth_levels）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave20_depth_levels"
down_revision = "wave19_resource_cooldown"


def upgrade() -> None:
    op.create_table(
        "ai_depth_levels",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("effect", sa.Text(), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default="true"),
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
        sa.UniqueConstraint("key"),
    )
    op.create_index("ix_ai_depth_levels_key", "ai_depth_levels", ["key"])


def downgrade() -> None:
    op.drop_index("ix_ai_depth_levels_key", table_name="ai_depth_levels")
    op.drop_table("ai_depth_levels")
