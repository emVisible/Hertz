"""wave34_layout_revisions_updated: 补 layout_revisions.updated_at（模型/迁移漂移修复）。

背景：`BaseModel` 给每张表声明 created_at + updated_at（后者带 onupdate），
而 `wave10_layout_data_safety` 手写建表 SQL 时只给了 created_at。ORM 的 INSERT
带 `RETURNING updated_at`，库里没这列 → asyncpg UndefinedColumnError：
**MD Studio 每次保存（PUT 走 _snapshot）与删除（删除前也要快照一份）都 500**，
界面表现就是「保存失败」和「删除无效」。

为什么测试没拦住：测试库（hertz_test）的 schema 由 `create_all` 从**模型**重建，
永远带着这列；只有走 alembic 的库才缺。这是 create_all 与迁移两条建 schema
路径分叉的典型漂移（AXIOM §22.1 口径）。

修法：不回头改 wave10——已 apply 的迁移改了不会重跑，改了反而让新库与旧库
走两条路。补一条迁移把列加上：迁移一旦发布就是历史，漂移只能用新迁移追平。

存量行回填 created_at 而不是迁移执行时间：快照落盘后不会再被改，
updated_at 与 created_at 本就同值，回填各自的原值最诚实。

revision id 压在 31 字符：alembic 自建的 alembic_version.version_num 是
VARCHAR(32)，超长的 id 会在 UPDATE version_num 时 StringDataRightTruncation
（整个迁移事务回滚，alter 白做）——守卫见
tests/test_migration_bootstrap.py::test_revision_ids_fit_alembic_version_column。

"""

import sqlalchemy as sa
from alembic import op

revision = "wave34_layout_revisions_updated"
down_revision = "wave10_layout_data_safety"


def upgrade() -> None:
    conn = op.get_bind()
    # 四步而不是一句 ADD COLUMN NOT NULL DEFAULT now()：后者会把存量行的
    # updated_at 统一抹成迁移执行时间，而快照的真实「写入时间」就是 created_at
    conn.execute(
        sa.text("ALTER TABLE layout_revisions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ")
    )
    conn.execute(
        sa.text("UPDATE layout_revisions SET updated_at = created_at WHERE updated_at IS NULL")
    )
    conn.execute(sa.text("ALTER TABLE layout_revisions ALTER COLUMN updated_at SET DEFAULT now()"))
    conn.execute(sa.text("ALTER TABLE layout_revisions ALTER COLUMN updated_at SET NOT NULL"))


def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("ALTER TABLE layout_revisions DROP COLUMN IF EXISTS updated_at"))
