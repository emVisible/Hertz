"""wave24_story_selftext: 文字故事帖正文（情感频道第二阶段·半自动产线）。

text_only 帖此前在采集时被丢弃；现保留正文供「文字帖 → 中文故事脚本 →
TTS 配音 → 图文合成」产线使用（v0.11.7）。
"""

import sqlalchemy as sa
from alembic import op

revision = "wave24_story_selftext"
down_revision = "wave23_phase_reference"


def upgrade() -> None:
    op.add_column("items", sa.Column("selftext", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("items", "selftext")
