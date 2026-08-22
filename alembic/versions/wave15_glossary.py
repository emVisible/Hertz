"""wave15_glossary: 翻译术语表（v0.15，VideoLingo 精华借鉴）。"""

import sqlalchemy as sa
from alembic import op

revision = "wave15_glossary"
down_revision = "3977f1500321"


def upgrade() -> None:
    op.create_table(
        "glossary_terms",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("source_term", sa.String(120), nullable=False, unique=True, index=True),
        sa.Column("target_term", sa.String(120), nullable=False),
        sa.Column("domain", sa.String(32), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("glossary_terms")
