"""wave30_item_invalid: items 新增布尔 `is_invalid`（v0.33 空壳条目隔离）。

实测背景：库里 2011 条 `media_url == source_url`（帖子页 URL 被当媒体直链），其中
1989 条连 selftext 都没有。它们被标成 video_raw 计入 `discovered`，于是流水线可操作
队列里 42% 是必然失败的条目，点下载就去抓被 Reddit 机器人拦截的页面（403），并把
整个域冻进 CDN 冷却，连带同域 2089 条真视频一起停摆。

为什么是**新增布尔**而不是复用现成字段：
- `queue_phase` 是发布排队字段（值域 ''/holding/ready，权威在 publish_queue.py）。
  往里塞 'invalid' 会漏进 `service_schedule.py` 的**反向**过滤（`!= 'holding'`），
  空壳会被自动分槽排期进内容日历。
- `item_type` 是产线路由开关（category.py 决定 B 站分区、heuristic_score.py 决定
  评分权重、helpers.py 等四处 `or "video_raw"` 兜底）。加第四值会被这些
  「不认识就当视频」的分支继续往下推。
- `is_lowscore`（wave4）已经立着同形状的先例：质量标记用独立布尔，进异常区
  专属池子，不参与主队列。

不建索引（v0.32 S2 实测口径）：按本轮数字 is_invalid 占比约 38%，选择性太低，
全表扫与索引扫同量级；声明 index=True 只会让模型与库长期不一致。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave30_item_invalid"
down_revision = "wave29_monoline_brand"


def upgrade() -> None:
    op.add_column(
        "items",
        sa.Column("is_invalid", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("items", "is_invalid")
