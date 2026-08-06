"""wave7b_phase_prompt_fields: agent role/method/style/model/retries per phase."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "wave7b_phase_prompt_fields"
down_revision = "wave7_phases"


def upgrade() -> None:
    op.add_column("phases", sa.Column("role", sa.String(120), nullable=False, server_default=""))
    op.add_column("phases", sa.Column("method", sa.Text(), nullable=False, server_default=""))
    op.add_column("phases", sa.Column("style", JSONB(), nullable=True))
    op.add_column("phases", sa.Column("model", sa.String(64), nullable=False, server_default=""))
    op.add_column("phases", sa.Column("retries", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    op.drop_column("phases", "retries")
    op.drop_column("phases", "model")
    op.drop_column("phases", "style")
    op.drop_column("phases", "method")
    op.drop_column("phases", "role")
