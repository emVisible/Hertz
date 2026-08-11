"""wave23_phase_reference: 工序参考素材文件（v0.7.2）。

agent 工序可配 reference（相对 data_dir 路径列表），运行时读取注入
system prompt【参考规则】段——文件是单一真相源，改文件即改规则。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave23_phase_reference"
down_revision = "wave22_brief_groups"


def upgrade() -> None:
    op.add_column(
        "phases",
        sa.Column("reference", sa.JSON(), nullable=False, server_default="[]"),
    )


def downgrade() -> None:
    op.drop_column("phases", "reference")
