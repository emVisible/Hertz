"""wave11_model_fetch_cache: ai_providers 加 last_fetch_at（模型列表拉取缓存时间，v5.8）。

模型列表只允许手动拉取（防限流）：fetch-models 更新该时间戳，
前端展示「上次拉取」，并在冷却窗口内拒绝重复拉取。
"""

import sqlalchemy as sa

from alembic import op

revision = "wave11_model_fetch_cache"
down_revision = "wave10b_buff_polarity"


def upgrade() -> None:
    op.add_column(
        "ai_providers",
        sa.Column("last_fetch_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ai_providers", "last_fetch_at")
