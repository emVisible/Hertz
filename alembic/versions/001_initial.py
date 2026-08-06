"""Initial migration: empty.

Wave 0 establishes the migration pipeline only. Domain tables arrive with
Wave 1 (infrastructure + AI layer) in migration 002.

Revision ID: 001_initial
Revises:
Create Date: 2026-07-31
"""

from collections.abc import Sequence

revision: str = "001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
