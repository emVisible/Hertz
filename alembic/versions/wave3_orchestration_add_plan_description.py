"""Wave 3 orchestration: add plans.description.

Revision ID: wave3_orchestration
Revises: 47191deda3cf
Create Date: 2026-07-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "wave3_orchestration"
down_revision: str | None = "47191deda3cf"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "plans", sa.Column("description", sa.Text(), server_default="", nullable=False)
    )


def downgrade() -> None:
    op.drop_column("plans", "description")
