"""wave18_produce_options: items 加入生产方式模块集合（v0.3.3）。

预处理阶段人工选择加工方案：直发/配音/字幕/翻译/静音 模块多选。
默认 {"voice": true, "subtitle": true, "translate": true}（现状行为：
英文旁白 + 中文字幕），存量兼容无缝。
"""

import sqlalchemy as sa

from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "wave18_produce_options"
down_revision = "wave17_item_seq"

DEFAULT_OPTIONS = {"voice": True, "subtitle": True, "translate": True}


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column(
            "produce_options",
            JSONB(),
            nullable=True,
        ),
    )
    # 存量条目默认 = 现状行为（英文旁白 + 中文字幕）
    conn = op.get_bind()
    items = sa.table("items", sa.column("produce_options", JSONB()))
    conn.execute(
        items.update().where(items.c.produce_options.is_(None)).values(produce_options=DEFAULT_OPTIONS)
    )


def downgrade() -> None:
    op.drop_column("items", "produce_options")
