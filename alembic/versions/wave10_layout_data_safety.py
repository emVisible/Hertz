"""wave10_layout_data_safety: 排版稿数据安全（回收站 + 版本历史）。

接在 `wave33_layout`（layouts 表那次迁移）之后——它是排版稿这条线当前的 head。
挂在别的分支上会让 heads 从 2 变成 3，而 `tests/test_board_domain.py`
里有一条守卫专门盯这个：**谁自己开了头，就说明接错了线**。

动机：MD Studio 面板里 `DELETE /api/layout/{id}` 是**硬删**——点一下"删除"就没了，
没有回收站、没有历史、点错一次无法挽回。这是"用界面操作就能造成不可逆损失"的典型。
本次加两件地基：

① `layouts.deleted_at` 软删列 → 回收站。列表默认过滤已删，恢复后原样回来。
   **不许用 `is_deleted` 布尔**：布尔会被忘记置位，而软删的时间戳能回答"什么时候删的"。
② `layout_revisions` 版本表 → 每次 PUT 落一份快照（源文 + 平台 + 主题 + 配置 + 封面）。
   撤销/重做在内存里做（见前端 `draftHistory`），但**跨会话**只能靠这张表：
   误操作、坏更新、或者用户自己改坏了想回退，都得有个落盘的东西可依。

两张表的取舍：`layout_revisions` 存**整份**快照而不是 diff。理由是 diff 要重建中间态，
而排版稿的体积（几十 KB 文本）对单用户桌面应用完全可接受；省下的那点空间
换不来"能直接回到任意历史版本"这件事的价值。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave10_layout_data_safety"
down_revision = "wave33_layout"


def upgrade() -> None:
    conn = op.get_bind()
    # ① 软删列
    conn.execute(
        sa.text("ALTER TABLE layouts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")
    )
    # 查询索引：列表默认 `deleted_at IS NULL ORDER BY updated_at DESC`，
    # 没有索引时稿件一多就退化成全表扫
    conn.execute(
        sa.text(
            "CREATE INDEX IF NOT EXISTS ix_layouts_live "
            "ON layouts (updated_at DESC) WHERE deleted_at IS NULL"
        )
    )
    # ② 版本表
    conn.execute(
        sa.text(
            """
            CREATE TABLE IF NOT EXISTS layout_revisions (
                id UUID PRIMARY KEY,
                layout_id UUID NOT NULL REFERENCES layouts(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                title VARCHAR(255) NOT NULL DEFAULT '',
                source_md TEXT NOT NULL DEFAULT '',
                source_ref VARCHAR(1024),
                platform VARCHAR(16) NOT NULL DEFAULT 'wechat',
                theme_id VARCHAR(128) NOT NULL DEFAULT '',
                overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
                cover JSONB NOT NULL DEFAULT '{}'::jsonb,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                UNIQUE (layout_id, seq)
            )
            """
        )
    )
    conn.execute(
        sa.text(
            "CREATE INDEX IF NOT EXISTS ix_layout_revisions_layout "
            "ON layout_revisions (layout_id, seq DESC)"
        )
    )


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("DROP TABLE IF EXISTS layout_revisions"))
    conn.execute(sa.text("DROP INDEX IF EXISTS ix_layouts_live"))
    conn.execute(sa.text("ALTER TABLE layouts DROP COLUMN IF EXISTS deleted_at"))
