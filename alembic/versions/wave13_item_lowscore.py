"""wave13_item_lowscore: items 加 is_lowscore（低分标记，v0.2.0）。

参考原项目 Autarkeia「低分可复用」：评分低于阈值的条目不再自动 reject
（自动丢弃），改为 scored + is_lowscore 标记，进入审核由人工决定。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave13_item_lowscore"
down_revision = "wave12_publish_schedule"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("is_lowscore", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("items", "is_lowscore")
