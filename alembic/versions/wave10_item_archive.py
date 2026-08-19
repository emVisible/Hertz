"""wave10_item_archive: item 软归档标记（备用库）。

删除入口收口异常区：归档 = 磁盘清理 + 字段清洗 + 标记 archived（保留基础数据），
不物理删行；purge（彻底删除）由 service 层直接删行，无需迁移。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave10_item_archive"
down_revision = "wave9b_role_simplify"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("archived", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("items", "archived")