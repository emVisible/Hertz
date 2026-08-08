"""wave15_failure_class: items 加 error_class（失败分类，v0.2.1）。

参考原项目 Autarkeia 失败分类看板：403/429/tts/llm/ffmpeg 等类别
按类统计 + 同类批量重试，替代纯文本 error 的不可聚合。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave15_failure_class"
down_revision = "wave14_phases_unpin_model"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("error_class", sa.String(32), server_default="", nullable=False),
    )


def downgrade() -> None:
    op.drop_column("items", "error_class")
