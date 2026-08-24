"""wave20_channels: 栏目实体表 + 条目栏目绑定列（v0.22 栏目化内容工厂）。"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "wave20_channels"
down_revision = "wave19_channel_insights"


def upgrade() -> None:
    op.create_table(
        "channels",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("public_id", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("source_pool", postgresql.JSONB(), nullable=True),
        sa.Column("voice", sa.String(64), nullable=True),
        sa.Column("bili_tid", sa.Integer(), nullable=True),
        sa.Column("desc_template", sa.Text(), nullable=True),
        sa.Column("tags", postgresql.JSONB(), nullable=True),
        sa.Column("title_style_prompt", sa.Text(), nullable=True),
        sa.Column("persona_prompt", sa.Text(), nullable=True),
        sa.Column("intro_config", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_channels_public_id", "channels", ["public_id"])
    op.add_column(
        "items",
        sa.Column(
            "channel_key",
            sa.String(64),
            nullable=True,
            comment="归属栏目 public_id（collect 时按栏目源池匹配写入）",
        ),
    )


def downgrade() -> None:
    op.drop_column("items", "channel_key")
    op.drop_index("ix_channels_public_id", table_name="channels")
    op.drop_table("channels")
