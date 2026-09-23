"""wave26_item_priority: 制作优先级（v0.26 运营面板）。

批量制作队列拖拽排序落库：engine 取件按 priority 降序。
默认 0，存量行为等价。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave26_item_priority"
down_revision = "wave25_style_presets"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("priority", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("items", "priority")
