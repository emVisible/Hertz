"""wave7_phases: user-maintainable phase catalog."""

import sqlalchemy as sa
from alembic import op

revision = "wave7_phases"
down_revision = "wave6_audit"


def upgrade() -> None:
    op.create_table(
        "phases",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("key", sa.String(64), unique=True, index=True, nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("phase_type", sa.String(16), nullable=False, server_default="agent"),
        sa.Column("agent_key", sa.String(64), nullable=False, server_default=""),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("output_file", sa.String(64), nullable=False, server_default=""),
        sa.Column("phase_group", sa.String(32), nullable=False, server_default="custom"),
        sa.Column("timeout", sa.Integer(), nullable=False, server_default="300"),
        sa.Column("builtin", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("phases")
