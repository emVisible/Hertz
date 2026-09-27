"""wave29 monoline brand: 用户级默认外观单行表（只加表）。"""

import sqlalchemy as sa
from alembic import op

revision = "wave29_monoline_brand"
down_revision = "wave28_monoline_tables"


def upgrade() -> None:
    op.create_table(
        "monoline_brand",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("theme", sa.String(length=64), nullable=False),
        sa.Column("accent", sa.String(length=32), nullable=True),
        sa.Column("logo_name", sa.String(length=255), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("monoline_brand")
