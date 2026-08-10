"""wave17_item_seq: items 加入库自增序号（v0.3.1）。

同批插入的 created_at 相同（PostgreSQL now() 为事务开始时间），
「最新/最旧」排序无法区分同批先后。seq 提供真实入库顺序
（参考原项目 SQLite rowid 语义）。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave17_item_seq"
down_revision = "wave16_source_health"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "seq",
            sa.BigInteger(),
            sa.Identity(always=False),
            nullable=False,
        ),
    )
    op.create_index("ix_items_seq", "items", ["seq"])


def downgrade() -> None:
    op.drop_index("ix_items_seq", table_name="items")
    op.drop_column("items", "seq")
