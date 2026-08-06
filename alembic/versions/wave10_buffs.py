"""wave10_buffs: Buff 库表（v5.0）。

ai_buffs：轻量/重量 buff（态度/话术注入）。
plans.buff_keys：计划级持久 buff 引用（JSONB）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave10_buffs"
down_revision = "wave9b_role_simplify"

# 启动种子（bootstrap）：首次建表时给 key 占位。
# 真实内容以 backend/orchestration/buffs.py BUILTIN_BUFFS/RANDOM_BUFFS 为准——
# BuffService._seed 首次访问会同步代码版本（内置以代码为单一真相源，AXIOM §1.2）。
_BUILTIN = [
    {
        "key": "human_touch",
        "name": "人情味",
        "kind": "lightweight",
        "effect": "多用具体的生活细节与自嘲，允许不完美；像一个真实的、有温度的人在说话，"
                  "而不是机构在发声。可以偶尔跑题到自己的经历，但要收得回来。",
        "category": "stable",
    },
    {
        "key": "de_ai",
        "name": "去 AI 味",
        "kind": "lightweight",
        "effect": "删除一切 AI 腔：'总而言之''值得注意的是''在这个快速发展的时代''不仅…而且…'"
                  "等套话；避免排比堆砌；句子长短错落，像手写而不是模板生成。",
        "category": "stable",
    },
    {
        "key": "firm_tone",
        "name": "语气强硬",
        "kind": "lightweight",
        "effect": "观点直接、不留余地；敢于下判断，不模棱两可；少用'可能''或许'，"
                  "多用'我认为''事实是'。",
        "category": "stable",
    },
    {
        "key": "concise",
        "name": "简洁有力",
        "kind": "lightweight",
        "effect": "每句删到不能再删；能用 5 个词不用 10 个；去掉所有装饰性形容词；"
                  "读完要让人感觉'说清楚了'而不是'写了挺多'。",
        "category": "stable",
    },
    {
        "key": "storyteller",
        "name": "故事化",
        "kind": "heavy",
        "effect": "用具体场景、人物和冲突来讲，而不是抽象论述。\n"
                  "规则：\n"
                  "① 开头从一个具体瞬间切入（不是背景介绍）；\n"
                  "② 论证嵌进叙事里，观点由人物行动带出；\n"
                  "③ 收尾回到开头的场景，形成闭环。",
        "category": "stable",
    },
    {
        "key": "second_look",
        "name": "二次把关",
        "kind": "heavy",
        "effect": "完成初稿后切换读者视角再审一遍：\n"
                  "① 哪里读起来像套路；\n"
                  "② 哪个论点站不住；\n"
                  "③ 哪句可以删。\n"
                  "把审出的问题直接改掉，输出最终版。",
        "category": "stable",
    },
    {
        "key": "wild_card",
        "name": "随机应变",
        "kind": "lightweight",
        "effect": "从随机池抽取的 buff（见 category=random 的条目）。",
        "category": "stable",
    },
]


def upgrade() -> None:
    op.create_table(
        "ai_buffs",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(16), server_default="lightweight", nullable=False),
        sa.Column("effect", sa.Text(), server_default="", nullable=False),
        sa.Column("category", sa.String(16), server_default="stable", nullable=False),
        sa.Column("enabled", sa.Boolean, server_default=sa.true(), nullable=False),
        sa.Column("builtin", sa.Boolean, server_default=sa.false(), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default="0", nullable=False),
    )
    op.create_index("ix_ai_buffs_key", "ai_buffs", ["key"], unique=True)

    conn = op.get_bind()
    for i, buff in enumerate(_BUILTIN):
        conn.execute(
            sa.text(
                """
                INSERT INTO ai_buffs
                (id, created_at, updated_at, key, name, kind, effect, category,
                 enabled, builtin, sort_order)
                VALUES
                (gen_random_uuid(), now(), now(), :key, :name, :kind, :effect,
                 :category, true, true, :sort_order)
                """
            ),
            {
                "key": buff["key"],
                "name": buff["name"],
                "kind": buff["kind"],
                "effect": buff["effect"],
                "category": buff["category"],
                "sort_order": i,
            },
        )

    op.add_column("plans", sa.Column("buff_keys", sa.JSON(), server_default="[]", nullable=False))


def downgrade() -> None:
    op.drop_column("plans", "buff_keys")
    op.drop_table("ai_buffs")
