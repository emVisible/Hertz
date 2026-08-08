"""Orchestration domain: phase registry and default templates.

The built-in phases mirror the Mojito workflow (8 phases, 7 enabled by
default + content_pipeline). Each phase is either ``system`` (implemented
in the engine) or ``agent`` (executed through the AI router with a role
prompt).
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class PhaseDef:
    key: str
    name: str
    description: str
    phase_type: str  # "system" | "agent"
    agent_key: str = ""
    phase_group: str = "infrastructure"
    # File this phase produces in the run directory ("" = none)
    output_file: str = ""
    timeout: int = 300
    # Agent 工序的 LLM 配置（工序库可查看/编辑；单一真相源，seed 进 phases 表）。
    # model 为空 = 跟随全局默认（Studio 主模型/角色解析），填了才是显式覆盖。
    role: str = ""
    method: str = ""
    style: list[str] = field(default_factory=list)
    model: str = ""
    retries: int = 0


PHASES: tuple[PhaseDef, ...] = (
    PhaseDef(
        key="build_brief",
        name="组建创意策略",
        description="环境状态 + 输入分析：素材本质、中心主张、结构骨架、可挖延伸、禁忌取舍",
        phase_type="system",
        phase_group="brief",
        output_file="brief.md",
        timeout=30,
    ),
    PhaseDef(
        key="director",
        name="创意定调",
        description="核心主张(≤7字)、视觉母题、论证链",
        phase_type="agent",
        agent_key="director",
        phase_group="create",
        output_file="director.md",
        timeout=300,
        role="创意总监",
        method=(
            "1. 输入消化：通读策略 brief 与素材，提炼核心主张候选（≤7字，宁锋利勿平淡）\n"
            "2. 定调：确定视觉母题（3 个语义转换）与论证链（5 步证明）\n"
            "3. 减法：杀掉 80% 的平庸创意，只留最锋利的一个方向\n"
            "4. 产出：director.md 交付「核心主张 + 母题 + 论证链」，供后续阶段引用"
        ),
        style=["果断", "高概念"],
        retries=2,
    ),
    PhaseDef(
        key="writer",
        name="内容创作",
        description="展示而非说教、感官质感、节奏留白",
        phase_type="agent",
        agent_key="writer",
        phase_group="create",
        output_file="writer.md",
        timeout=420,
        role="内容作家",
        method=(
            "1. 先列骨架：按 brief 的论证链展开章节，再落笔\n"
            "2. Show don't tell：每段给出质感细节（冷金属/暖木/粗石），不抽象概括\n"
            "3. 节奏留白：长短句交替，段间留呼吸感\n"
            "4. 纪律：不照搬素材原文，只取素材的洞察\n"
            "5. 产出：writer.md 即完整正文草稿，可直接成稿"
        ),
        style=["感官", "节奏"],
        retries=2,
    ),
    PhaseDef(
        key="visual_director",
        name="视觉设计",
        description="构图、光影、材质意识；依据 Style 块自动渲染配图",
        phase_type="agent",
        agent_key="visual_director",
        phase_group="create",
        output_file="visual_director.md",
        timeout=300,
        role="视觉导演",
        method=(
            "1. 通读正文与母题，确定整体视觉基调（光/色/材质）\n"
            "2. 拆解关键场景，为每个场景写一段视觉描述\n"
            "3. 输出 Style 块（## Style N 开头）：每块一段可执行的图像提示词\n"
            "   ——光从哪来、主色调、材质、构图\n"
            "4. 检查：每个 Style 块都能独立生成配图，不依赖上下文"
        ),
        style=["光影", "材质"],
        retries=2,
    ),
    PhaseDef(
        key="editor",
        name="质量审校",
        description="事前验尸，删掉不值得留下的内容",
        phase_type="agent",
        agent_key="editor",
        phase_group="create",
        output_file="editor.md",
        timeout=300,
        role="内容编辑",
        method=(
            "1. Premortem：假设成品已经失败，列出 3 个最可能的失败原因\n"
            "2. 对照检查：主张是否清晰、正文有无废话、视觉是否匹配\n"
            "3. 删减：不配存在的句子就删，宁短勿长\n"
            "4. 产出：editor.md 给出「问题清单 + 修改建议」，不直接重写正文"
        ),
        style=["锋利", "减法"],
        retries=2,
    ),
    PhaseDef(
        key="distribution",
        name="分发策略",
        description="分发/转化/关系延续：适配平台节奏、钩子位置、克制收尾（禁止评论引导话术）",
        phase_type="agent",
        agent_key="distribution",
        phase_group="distribute",
        output_file="distribution.md",
        timeout=300,
        role="分发策略师",
        method=(
            "1. 识别平台与发布节奏，确定钩子位置（前 3 句内）\n"
            "2. 设计克制收尾：留白大于号召\n"
            "3. 纪律：禁止任何评论/点赞/关注/转发引导话术\n"
            "4. 关系延续：给出 1 条后续内容线索\n"
            "5. 产出：distribution.md 交付平台策略 + 文案要点"
        ),
        style=["平台感", "克制"],
        retries=2,
    ),
    PhaseDef(
        key="package",
        name="打包交付",
        description="终检闸门（必需产物齐全）+ 汇总成品，生成 final.md",
        phase_type="system",
        phase_group="infrastructure",
        output_file="final.md",
        timeout=120,
    ),
    PhaseDef(
        key="content_pipeline",
        name="内容流水线",
        description="触发执行域全流程：采集→评分→下载→生产（至审核闸门）",
        phase_type="system",
        phase_group="infrastructure",
        output_file="pipeline.md",
        timeout=900,
    ),
)

PHASE_INDEX = {p.key: p for p in PHASES}

# 历史工序 key → 新工序 key（wave7 精简合并）。旧计划里的 key 会被
# 平滑迁移到新工序，避免保存被拒/前端渲染出原始 i18n key。
LEGACY_PHASE_ALIASES: dict[str, str] = {
    "scout": "",  # 侦察：无实际产物，删除
    "analyst": "",  # 分析师：无实际产物，删除
    "growth_director": "distribution",
    "outreach_specialist": "distribution",
    "community_manager": "distribution",
    "preflight": "build_brief",  # 环境检查并入策略分析
    "image_gen": "visual_director",  # 配图渲染并入视觉设计
    "quality_gate": "package",  # 终检闸门并入打包交付
}

# Default plan: all phases enabled except content_pipeline (平台依赖工序，
# 默认不触发——Studio 不依赖采集平台，除非用户在工序管理中显式启用).
DEFAULT_PHASE_ORDER: list[dict] = [
    {"key": p.key, "enabled": p.key != "content_pipeline", "config": {}}
    for p in PHASES
]


# 内置 agent 工序的出厂 LLM 配置——直接从 PHASES 派生（单一真相源，AXIOM §1.2）。
# seed/恢复默认/角色库全部消费同一份 PhaseDef，杜绝两处维护。
def phase_agent_config(p: PhaseDef) -> dict:
    return {
        "role": p.role,
        "method": p.method,
        "style": list(p.style),
        "model": p.model,
        "timeout": p.timeout,
        "retries": p.retries,
    }


DEFAULT_BRIEF_CONTENT = """# 创意策略模板

## 品牌
（品牌定位、气质、一句话介绍）

## 策略
- 内容支柱：真实、有用、有审美
- 表达基调：克制但有温度，拒绝说教
- 视觉基调：电影感光影 + 材质细节

## 参考素材
（填写参考链接或案例）

## 禁忌
- 不夸大效果、不制造焦虑
- 不堆砌术语
"""
