"""wave27_plan_brief_group_fk: plans.brief_group_id 补上外键（v0.32 S2 漂移清偿）。

模型侧 `plan.brief_group_id` 一直声明着 `ForeignKey("brief_groups.id",
ondelete="SET NULL")`，但库里从未有过该约束——`alembic check` 每轮报
`add_fk`，混在真正危险的漂移项里（同批被报出的还有 2 个 remove_table，
已由 D-201 的 autogenerate 闸拦下）。约束缺失意味着删策略组时悬挂引用
不会被置空，只能靠应用层自觉。

先清孤儿再加约束：用户库里可能存在 brief_groups 行被删后留下的旧 id，
直接 create_foreign_key 会让整条迁移失败——而迁移失败等于固化后端首启即崩
（v0.31 已为此踩过两次）。置空悬挂引用正是模型声明的 SET NULL 语义，
不新增任何行为。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave27_plan_brief_group_fk"
down_revision = "wave26_item_priority"


def upgrade() -> None:
    op.execute(
        """
        UPDATE plans
           SET brief_group_id = NULL
         WHERE brief_group_id IS NOT NULL
           AND NOT EXISTS (
               SELECT 1 FROM brief_groups bg WHERE bg.id = plans.brief_group_id
           )
        """
    )
    op.create_foreign_key(
        "plans_brief_group_id_fkey",
        "plans",
        "brief_groups",
        ["brief_group_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "plans_brief_group_id_fkey", "plans", type_="foreignkey"
    )
