"""wave10_resource_cooldown: 媒体资源冷却（v0.3.6 冰川式）——按媒体域冻结表。

下载失败按媒体域指数退避冷却（见 ResourceCooldown），跳过冷却中的域。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave19_resource_cooldown"
down_revision = "wave18_produce_options"


def upgrade() -> None:
    op.create_table(
        "resource_cooldown",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("domain", sa.String(length=128), nullable=False),
        sa.Column("fail_level", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("until_epoch", sa.Float(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        sa.UniqueConstraint("domain"),
    )
    op.create_index("ix_resource_cooldown_domain", "resource_cooldown", ["domain"])


def downgrade() -> None:
    op.drop_index("ix_resource_cooldown_domain", table_name="resource_cooldown")
    op.drop_table("resource_cooldown")
