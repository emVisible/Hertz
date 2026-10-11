"""wave32_item_clips: items 新增 JSONB `clips`（v0.35 多素材合集编排）。

存在理由（用户原话）：「我有很多的视频，但我上传的话必然很容易给我限流……把很多
视频放到一起、拼凑到一起，加一个手尾或者加一些篇幅之间的过渡效果，从一级一篇改为
一级多篇」。

发布侧是「一个 item 一次上传」——`publishers/router.py` 的 biliup 固定单文件命令，
`enqueue_batch` 也只是逐条循环。把 N 条素材拼成一条 = 上传次数除以 N，这是那条
限制下唯一有效的减法。

为什么是**新增 clips 列**而不是塞进 `produce_options`：
- `produce_options` 已经有三份归一实现（helpers.normalize_produce_flags /
  service_review.normalize_produce_options / 前端 normalizeOptions）且语义已经漂移
  （后端「部分设置」会把 subtitle/translate 补成 True，前端默认是 False）。再往里
  塞一个嵌套结构只会加剧。
- 语义层级不同：`produce_options` = **怎么加工**（五个模块开关）；`clips` =
  **拿什么加工**（片段列表 + 顺序 + 转场 + 手尾）。两者生命周期也不同——生产方式是
  批量套用的（ProduceBatchModal 一次改多条），clips 是逐条精细编排的。混在一起会
  被批量操作互相覆盖。
- `Item` 上没有 parent_id/collection_id 系列字段，全仓也不存在合集概念，所以这不是
  「已有形状上加字段」，是新增一个形状。

列形状（JSONB，nullable）：
```json
{"clips": [{"item_id": "uuid", "transition": "fade", "transition_s": 0.6}, ...],
 "outro": {"enabled": true, "duration_s": 2.5},
 "target": {"width": 1280, "height": 720, "fps": 30}}
```
用 `item_id` 引用而非拷贝 raw_path：打回重制会重新分配 `output_dir`，路径引用会失效。

不建索引（同 wave30 / wave31 的 `focus_date` 口径）：合集条目占全库比例极低，
选择性太低，索引不回本；声明 index=True 只会让模型与库长期不一致（`alembic check`
每轮都报）。

接在主线 `wave31_board_goal` 之后；悬空分支 `wave21_glossary_remove` 按定档不动，
所以本仓 alembic heads 迁移前后都是 2（守卫
`tests/test_board_domain.py::test_wave31_joins_main_line_and_heads_stay_two` 钉住这件事）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave32_item_clips"
down_revision = "wave31_board_goal"


def upgrade() -> None:
    op.add_column("items", sa.Column("clips", sa.dialects.postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "clips")
