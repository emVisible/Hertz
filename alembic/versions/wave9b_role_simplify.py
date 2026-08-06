"""wave9b_role_simplify: 角色简化（v4.1）——删除执行配置列。

method/style/model/timeout/retries 从角色移到工序/编排层；已有数据并入
description（防止丢失用户内容），然后删列。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave9b_role_simplify"
down_revision = "wave9_roles"


def upgrade() -> None:
    conn = op.get_bind()
    # 已有 method/style 并入 description（避免数据丢失）
    rows = conn.execute(
        sa.text("SELECT id, description, method, style FROM roles")
    ).fetchall()
    for row in rows:
        parts = []
        if row.description:
            parts.append(row.description)
        if row.method:
            parts.append(f"## 方法论\n\n{row.method}")
        if row.style:
            style_list = row.style if isinstance(row.style, list) else []
            if style_list:
                parts.append(f"## 风格\n\n{', '.join(str(s) for s in style_list)}")
        if len(parts) > 1 or (parts and not row.description):
            conn.execute(
                sa.text("UPDATE roles SET description = :desc WHERE id = :id"),
                {"desc": "\n\n".join(parts), "id": row.id},
            )
    op.drop_column("roles", "retries")
    op.drop_column("roles", "timeout")
    op.drop_column("roles", "model")
    op.drop_column("roles", "style")
    op.drop_column("roles", "method")


def downgrade() -> None:
    op.add_column("roles", sa.Column("method", sa.Text(), server_default="", nullable=False))
    op.add_column("roles", sa.Column("style", sa.JSON(), server_default="[]", nullable=False))
    op.add_column("roles", sa.Column("model", sa.String(64), server_default="", nullable=False))
    op.add_column("roles", sa.Column("timeout", sa.Integer, server_default="300", nullable=False))
    op.add_column("roles", sa.Column("retries", sa.Integer, server_default="0", nullable=False))
