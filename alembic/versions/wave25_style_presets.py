"""wave25_style_presets: 风格预设（v0.26 创作资产）。

命名栏目创意包（音色/分区/简介模板/标签/标题风格/人设/片头），
一处定义，多栏目套用。无内置 seed，用户从栏目存为预设。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave25_style_presets"
down_revision = "wave24_story_selftext"


def upgrade() -> None:
    op.create_table(
        "style_presets",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("config_json", sa.Text(), nullable=True),
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
    op.drop_table("style_presets")
