"""wave21_glossary_remove: 术语表功能整体移除（v0.22.x 翻译去 API 化，D-189）。

本地 Opus-MT 引擎无 prompt 注入点，术语表（LLM prompt 注入模式）随
LLM 翻译路径一并移除；表内无生产数据（dev/test 双库核验为空）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave21_glossary_remove"
down_revision = "wave20_channels"


def upgrade() -> None:
    op.drop_table("glossary_terms")


def downgrade() -> None:
    op.create_table(
        "glossary_terms",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("source_term", sa.String(120), nullable=False, unique=True, index=True),
        sa.Column("target_term", sa.String(120), nullable=False),
        sa.Column("domain", sa.String(32), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
