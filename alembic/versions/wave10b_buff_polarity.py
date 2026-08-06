"""wave10b_buff_polarity: Buff 表加 polarity（buff/debuff, v5.2）。

debuff = 反向提示词（指明"不要做什么"），与 buff 同一维护机制。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave10b_buff_polarity"
down_revision = "wave10_buffs"


def upgrade() -> None:
    op.add_column(
        "ai_buffs",
        sa.Column("polarity", sa.String(16), server_default="buff", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("ai_buffs", "polarity")
