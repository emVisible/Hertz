"""wave16_source_health: source_state 加连续失败/最后错误（数据源健康度 v0.2.1）。

参考原项目 Autarkeia 数据源健康度：按 (source, channel) 的连续失败与
成败比推导 dead / degraded / healthy 三态，健康度看板 + 供给告警。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave16_source_health"
down_revision = "wave15_failure_class"


def upgrade() -> None:
    op.add_column(
        "source_state",
        sa.Column("consecutive_fails", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("source_state", sa.Column("last_error", sa.Text(), nullable=True))
    op.add_column(
        "source_state",
        sa.Column("last_error_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("source_state", "last_error_at")
    op.drop_column("source_state", "last_error")
    op.drop_column("source_state", "consecutive_fails")
