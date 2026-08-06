"""wave8b_prompt_templates: 提示词模板库表（v2.4）。"""

import sqlalchemy as sa
from alembic import op

revision = "wave8b_prompt_templates"
down_revision = "wave8_ai_registry"


def upgrade() -> None:
    op.create_table(
        "ai_prompt_templates",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("key", sa.String(120), nullable=False),
        sa.Column("name", sa.String(120), server_default="", nullable=False),
        sa.Column("category", sa.String(32), server_default="agent", nullable=False),
        sa.Column("content", sa.Text(), server_default="", nullable=False),
        sa.Column("version", sa.Integer, server_default="1", nullable=False),
        sa.Column("customized", sa.Boolean, server_default=sa.false(), nullable=False),
    )
    op.create_index("ix_ai_prompt_templates_key", "ai_prompt_templates", ["key"], unique=True)


def downgrade() -> None:
    op.drop_table("ai_prompt_templates")
