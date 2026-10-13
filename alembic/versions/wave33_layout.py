"""wave33_layout: 排版稿表 layouts（超级 Markdown 模块 MD Studio，设计 §6，切片 D）。

一份排版稿 = 源文 markdown + 平台（wechat/xhs/zhihu）+ 主题 + 微调 overrides +
封面 cover。后端只做 CRUD/导入，零渲染（解析/排版/导出全在前端 mdcore）。
`source_ref` 记录来源：docs 空间相对路径或 `studio:<run slug>`，可空（粘贴新建）。

平台枚举不进库（不加 CHECK）：三平台集合由 pydantic Literal 在路由层拦住，
后续加平台不改库——与 monoline_jobs.status 等 String(32) 枚举同口径。

不建索引：排版稿是用户级小表（量级对标 monoline_presets），列表恒为全量
updated_at 倒序，索引不回本（wave30/wave31 同一口径）。

接在主线 `wave32_item_clips` 之后；悬空分支 `wave21_glossary_remove` 按定档不动，
迁移前后 alembic heads 都是 2（守卫
`tests/test_board_domain.py::test_wave31_joins_main_line_and_heads_stay_two`）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave33_layout"
down_revision = "wave32_item_clips"


def upgrade() -> None:
    op.create_table(
        "layouts",
        sa.Column("id", sa.dialects.postgresql.UUID(), primary_key=True),
        sa.Column("title", sa.String(255), nullable=False, server_default=""),
        sa.Column("source_md", sa.Text(), nullable=False, server_default=""),
        sa.Column("source_ref", sa.String(1024), nullable=True),
        sa.Column("platform", sa.String(16), nullable=False, server_default="wechat"),
        sa.Column("theme_id", sa.String(128), nullable=False, server_default=""),
        sa.Column(
            "overrides",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "cover",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )


def downgrade() -> None:
    op.drop_table("layouts")
