"""wave7c_phase_archive: soft-delete flag for built-in phases."""

import sqlalchemy as sa
from alembic import op

revision = "wave7c_phase_archive"
down_revision = "wave7b_phase_prompt_fields"


def upgrade() -> None:
    op.add_column("phases", sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("phases", "archived")