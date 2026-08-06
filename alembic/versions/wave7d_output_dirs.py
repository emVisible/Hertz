"""wave7d_output_dirs: structured output directory names (date + sequence)."""

import sqlalchemy as sa
from alembic import op

revision = "wave7d_output_dirs"
down_revision = "wave7c_phase_archive"


def upgrade() -> None:
    op.add_column("workflow_runs", sa.Column("output_dir", sa.String(255), nullable=True))
    op.add_column("items", sa.Column("output_dir", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "output_dir")
    op.drop_column("workflow_runs", "output_dir")
