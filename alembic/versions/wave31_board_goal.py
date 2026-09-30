"""wave31_board_goal: 每日目标表 + items.focus_date/focus_note（v0.34 B 看板）。

接在主线 `wave30_item_invalid` 之后。悬空分支 `wave21_glossary_remove` 按定档**不动**，
所以本仓 alembic heads 迁移前后都是 2（守卫
`tests/test_board_domain.py::test_wave31_joins_main_line_and_heads_stay_two` 钉住这件事：
变成 1 说明有人合并了它，变成 3 说明这条迁移自己开了第三个头）。

升降级在一次性真库上跑过一轮（2026-09-30，`hertz_wave31_probe`）：
`upgrade heads` ⇒ 两列 + `daily_goal` 都在；`downgrade -1` ⇒ 两列与表都消失；
再 `upgrade wave31_board_goal` ⇒ 恢复。跑完即 `dropdb`，dev 库全程未被触碰。

为什么新表叫 `daily_goal` 而不是 `daily_plan`：`models/plan.py` 已被编排域占用
（`plans` / `Plan`），两个「plan」是两份真相。

为什么 `daily_goal.goal_date` 建唯一索引、而 `items.focus_date` **不建**索引：
前者查询恒为「按日期取一行」（选择性极高）；后者非空行集中在单日且占比极低，
索引不回本——同一份「先量再决定」的口径（v0.32 S2 清偿无效索引、wave30 的
`is_invalid` 不建索引都是这条）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave31_board_goal"
down_revision = "wave30_item_invalid"


def upgrade() -> None:
    op.create_table(
        "daily_goal",
        sa.Column("id", sa.dialects.postgresql.UUID(), primary_key=True),
        sa.Column("goal_date", sa.Date(), nullable=False),
        sa.Column("goal_text", sa.Text(), nullable=False, server_default=""),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("goal_date", name="uq_daily_goal_date"),
    )
    op.create_index("ix_daily_goal_goal_date", "daily_goal", ["goal_date"])
    op.add_column("items", sa.Column("focus_date", sa.Date(), nullable=True))
    op.add_column("items", sa.Column("focus_note", sa.Text(), nullable=True))


def downgrade() -> None:
    # 逆序：先删列，再删索引，最后删表（顺序错了在 PG 上会留下孤立索引）
    op.drop_column("items", "focus_note")
    op.drop_column("items", "focus_date")
    op.drop_index("ix_daily_goal_goal_date", table_name="daily_goal")
    op.drop_table("daily_goal")
