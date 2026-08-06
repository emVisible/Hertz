"""wave9_roles: 角色库 + 团队重构（班底 → 团队，角色独立成库）。

- 新建 roles 表（角色实体）
- 从 DEFAULT_AGENTS 种子 5 个内置角色
- 把已有 crews.agents（内联配置）转换为 roles 行，crews.agents 改写为角色 key 列表
- 幂等：可重复执行（存在即跳过）
"""

import json

import sqlalchemy as sa
from alembic import op

revision = "wave9_roles"
down_revision = "wave8b_prompt_templates"

# 与 backend/orchestration/phases.py DEFAULT_AGENTS 保持一致
_DEFAULT_ROLES = [
    {
        "key": "director",
        "name": "创意总监",
        "role_name": "创意总监",
        "method": "核心主张(≤7字) + 视觉母题(3 语义转换) + 论证链(5 步证明)，杀掉 80% 的创意；先吃透简报与素材再定调",
        "style": ["果断", "高概念"],
        "model": "deepseek-chat",
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "writer",
        "name": "内容作家",
        "role_name": "内容作家",
        "method": "Show don't tell: 每段有质感(冷金属/暖木/粗石)，留白是节奏的一部分；先列骨架再落笔，不照搬素材原文",
        "style": ["感官", "节奏"],
        "model": "deepseek-chat",
        "timeout": 420,
        "retries": 2,
    },
    {
        "key": "visual_director",
        "name": "视觉导演",
        "role_name": "视觉导演",
        "method": "每帧都是照片: 光从哪来、主色调、材质；理解模型如雕塑家理解大理石",
        "style": ["光影", "材质"],
        "model": "deepseek-chat",
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "editor",
        "name": "内容编辑",
        "role_name": "内容编辑",
        "method": "Premortem 事前验尸: 假设已经失败，找出弱点；不配存在的句子就删",
        "style": ["锋利", "减法"],
        "model": "deepseek-chat",
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "distribution",
        "name": "分发策略师",
        "role_name": "分发策略师",
        "method": "分发是创作的一部分: 平台节奏、钩子位置、克制收尾；禁止任何评论/点赞/关注/转发引导话术",
        "style": ["平台感", "克制"],
        "model": "deepseek-chat",
        "timeout": 300,
        "retries": 2,
    },
]


def _seed_roles() -> None:
    conn = op.get_bind()
    for i, role in enumerate(_DEFAULT_ROLES):
        exists = conn.execute(
            sa.text("SELECT 1 FROM roles WHERE key = :key"), {"key": role["key"]}
        ).scalar()
        if exists:
            continue
        conn.execute(
            sa.text(
                """
                INSERT INTO roles
                (id, created_at, updated_at, key, name, role_name, description,
                 method, style, model, timeout, retries, enabled, sort_order)
                VALUES
                (gen_random_uuid(), now(), now(), :key, :name, :role_name, '',
                 :method, CAST(:style AS jsonb), :model, :timeout, :retries, true, :sort_order)
                """
            ),
            {
                "key": role["key"],
                "name": role["name"],
                "role_name": role["role_name"],
                "method": role["method"],
                "style": json.dumps(role["style"]),
                "model": role["model"],
                "timeout": role["timeout"],
                "retries": role["retries"],
                "sort_order": i,
            },
        )


def _convert_crews() -> None:
    """旧 crews.agents（内联配置）→ roles 行 + agents 改写为 key 列表。"""
    conn = op.get_bind()
    rows = conn.execute(sa.text("SELECT id, agents FROM crews")).fetchall()
    for row in rows:
        agents = row.agents or []
        keys: list[str] = []
        for i, agent in enumerate(agents):
            if not isinstance(agent, dict):
                continue
            key = str(agent.get("key") or "")
            if not key:
                continue
            keys.append(key)
            exists = conn.execute(
                sa.text("SELECT 1 FROM roles WHERE key = :key"), {"key": key}
            ).scalar()
            if exists:
                continue
            conn.execute(
                sa.text(
                    """
                    INSERT INTO roles
                    (id, created_at, updated_at, key, name, role_name, description,
                     method, style, model, timeout, retries, enabled, sort_order)
                    VALUES
                    (gen_random_uuid(), now(), now(), :key, :name, :role_name, '',
                     :method, CAST(:style AS jsonb), :model, :timeout, :retries, true, :sort_order)
                    """
                ),
                {
                    "key": key,
                    "name": str(agent.get("name") or agent.get("role") or key),
                    "role_name": str(agent.get("role") or agent.get("name") or key),
                    "method": str(agent.get("method") or ""),
                    "style": json.dumps(agent.get("style") or []),
                    "model": str(agent.get("model") or ""),
                    "timeout": int(agent.get("timeout") or 300),
                    "retries": int(agent.get("retries") or 0),
                    "sort_order": i,
                },
            )
        if keys:
            conn.execute(
                sa.text("UPDATE crews SET agents = CAST(:keys AS jsonb) WHERE id = :id"),
                {"keys": json.dumps(keys), "id": row.id},
            )


def upgrade() -> None:
    op.create_table(
        "roles",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("role_name", sa.String(120), server_default="", nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("method", sa.Text(), server_default="", nullable=False),
        sa.Column("style", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("model", sa.String(64), server_default="", nullable=False),
        sa.Column("timeout", sa.Integer, server_default="300", nullable=False),
        sa.Column("retries", sa.Integer, server_default="0", nullable=False),
        sa.Column("enabled", sa.Boolean, server_default=sa.true(), nullable=False),
        sa.Column("sort_order", sa.Integer, server_default="0", nullable=False),
    )
    op.create_index("ix_roles_key", "roles", ["key"], unique=True)
    _seed_roles()
    _convert_crews()


def downgrade() -> None:
    op.drop_table("roles")
