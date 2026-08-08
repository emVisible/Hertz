"""wave14_phases_unpin_model: 内置工序不再锁定模型 + 升级内置 method 内容。

背景（AXIOM §1.2 单一真相源）：
- 旧版 DEFAULT_AGENTS 给每道内置 agent 工序 seed 了 model='deepseek-chat'，
  引擎解析链"团队→工序→main 角色"里工序总是赢，Studio 的全局模型选择永远不生效。
- 本次改动：内置工序出厂 model 置空（跟随全局），method 改写为结构化多行步骤。

迁移策略：只更新「仍是出厂值」的行——用户已编辑过的内容不动。
- model='deepseek-chat'（出厂锁定值）→ ''
- method 仍等于旧出厂文案的行 → 升级为新结构化内容
"""

import sqlalchemy as sa

from alembic import op

revision = "wave14_phases_unpin_model"
down_revision = "wave13_item_lowscore"

# 旧出厂 method（精确匹配 = 用户未编辑）→ 新结构化 method
_OLD_METHODS: dict[str, str] = {
    "director": "核心主张(≤7字) + 视觉母题(3 语义转换) + 论证链(5 步证明)，杀掉 80% 的创意；先吃透策略与素材再定调",
    "writer": "Show don't tell: 每段有质感(冷金属/暖木/粗石)，留白是节奏的一部分；先列骨架再落笔，不照搬素材原文",
    "visual_director": "每帧都是照片: 光从哪来、主色调、材质；理解模型如雕塑家理解大理石",
    "editor": "Premortem 事前验尸: 假设已经失败，找出弱点；不配存在的句子就删",
    "distribution": "分发是创作的一部分: 平台节奏、钩子位置、克制收尾；禁止任何评论/点赞/关注/转发引导话术",
}

_NEW_METHODS: dict[str, str] = {
    "director": (
        "1. 输入消化：通读策略 brief 与素材，提炼核心主张候选（≤7字，宁锋利勿平淡）\n"
        "2. 定调：确定视觉母题（3 个语义转换）与论证链（5 步证明）\n"
        "3. 减法：杀掉 80% 的平庸创意，只留最锋利的一个方向\n"
        "4. 产出：director.md 交付「核心主张 + 母题 + 论证链」，供后续阶段引用"
    ),
    "writer": (
        "1. 先列骨架：按 brief 的论证链展开章节，再落笔\n"
        "2. Show don't tell：每段给出质感细节（冷金属/暖木/粗石），不抽象概括\n"
        "3. 节奏留白：长短句交替，段间留呼吸感\n"
        "4. 纪律：不照搬素材原文，只取素材的洞察\n"
        "5. 产出：writer.md 即完整正文草稿，可直接成稿"
    ),
    "visual_director": (
        "1. 通读正文与母题，确定整体视觉基调（光/色/材质）\n"
        "2. 拆解关键场景，为每个场景写一段视觉描述\n"
        "3. 输出 Style 块（## Style N 开头）：每块一段可执行的图像提示词——光从哪来、主色调、材质、构图\n"
        "4. 检查：每个 Style 块都能独立生成配图，不依赖上下文"
    ),
    "editor": (
        "1. Premortem：假设成品已经失败，列出 3 个最可能的失败原因\n"
        "2. 对照检查：主张是否清晰、正文有无废话、视觉是否匹配\n"
        "3. 删减：不配存在的句子就删，宁短勿长\n"
        "4. 产出：editor.md 给出「问题清单 + 修改建议」，不直接重写正文"
    ),
    "distribution": (
        "1. 识别平台与发布节奏，确定钩子位置（前 3 句内）\n"
        "2. 设计克制收尾：留白大于号召\n"
        "3. 纪律：禁止任何评论/点赞/关注/转发引导话术\n"
        "4. 关系延续：给出 1 条后续内容线索\n"
        "5. 产出：distribution.md 交付平台策略 + 文案要点"
    ),
}


def upgrade() -> None:
    conn = op.get_bind()
    phases = sa.table(
        "phases",
        sa.column("key", sa.String),
        sa.column("builtin", sa.Boolean),
        sa.column("model", sa.String),
        sa.column("method", sa.Text),
    )
    # 1. 出厂锁定的模型（deepseek-chat）→ 置空，跟随全局默认
    conn.execute(
        phases.update()
        .where(phases.c.builtin.is_(True), phases.c.model == "deepseek-chat")
        .values(model="")
    )
    # 2. method 仍是旧出厂文案的内置工序 → 升级为结构化步骤
    for key, old in _OLD_METHODS.items():
        conn.execute(
            phases.update()
            .where(
                phases.c.builtin.is_(True),
                phases.c.key == key,
                phases.c.method == old,
            )
            .values(method=_NEW_METHODS[key])
        )


def downgrade() -> None:
    conn = op.get_bind()
    phases = sa.table(
        "phases",
        sa.column("key", sa.String),
        sa.column("builtin", sa.Boolean),
        sa.column("model", sa.String),
        sa.column("method", sa.Text),
    )
    # 出厂 model 置空的行 → 恢复 deepseek-chat（仅限 model='' 且未配置过其他值的行）
    conn.execute(
        phases.update()
        .where(phases.c.builtin.is_(True), phases.c.model == "")
        .values(model="deepseek-chat")
    )
    for key, old in _OLD_METHODS.items():
        conn.execute(
            phases.update()
            .where(
                phases.c.builtin.is_(True),
                phases.c.key == key,
                phases.c.method == _NEW_METHODS[key],
            )
            .values(method=old)
        )
