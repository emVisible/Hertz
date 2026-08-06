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
    crew_role: str = ""
    phase_group: str = "infrastructure"
    # File this phase produces in the run directory ("" = none)
    output_file: str = ""
    timeout: int = 300
    # Agent 工序的 LLM 配置（工序库可查看/编辑，回退到 DEFAULT_AGENTS）
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
        crew_role="创意总监",
        phase_group="create",
        output_file="director.md",
    ),
    PhaseDef(
        key="writer",
        name="内容创作",
        description="展示而非说教、感官质感、节奏留白",
        phase_type="agent",
        agent_key="writer",
        crew_role="内容作家",
        phase_group="create",
        output_file="writer.md",
    ),
    PhaseDef(
        key="visual_director",
        name="视觉设计",
        description="构图、光影、材质意识；依据 Style 块自动渲染配图",
        phase_type="agent",
        agent_key="visual_director",
        crew_role="视觉导演",
        phase_group="create",
        output_file="visual_director.md",
    ),
    PhaseDef(
        key="editor",
        name="质量审校",
        description="事前验尸，删掉不值得留下的内容",
        phase_type="agent",
        agent_key="editor",
        crew_role="内容编辑",
        phase_group="create",
        output_file="editor.md",
    ),
    PhaseDef(
        key="distribution",
        name="分发策略",
        description="分发/转化/关系延续：适配平台节奏、钩子位置、克制收尾（禁止评论引导话术）",
        phase_type="agent",
        agent_key="distribution",
        crew_role="分发策略师",
        phase_group="distribute",
        output_file="distribution.md",
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


# 内置 agent 工序的默认 LLM 配置（seed 到 phases 表；工序库可编辑）
DEFAULT_AGENTS: list[dict] = [
    {
        "key": "director",
        "role": "创意总监",
        "method": "核心主张(≤7字) + 视觉母题(3 语义转换) + 论证链(5 步证明)，杀掉 80% 的创意；先吃透策略与素材再定调",
        "model": "deepseek-chat",
        "style": ["果断", "高概念"],
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "writer",
        "role": "内容作家",
        "method": "Show don't tell: 每段有质感(冷金属/暖木/粗石)，留白是节奏的一部分；先列骨架再落笔，不照搬素材原文",
        "model": "deepseek-chat",
        "style": ["感官", "节奏"],
        "timeout": 420,
        "retries": 2,
    },
    {
        "key": "visual_director",
        "role": "视觉导演",
        "method": "每帧都是照片: 光从哪来、主色调、材质；理解模型如雕塑家理解大理石",
        "model": "deepseek-chat",
        "style": ["光影", "材质"],
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "editor",
        "role": "内容编辑",
        "method": "Premortem 事前验尸: 假设已经失败，找出弱点；不配存在的句子就删",
        "model": "deepseek-chat",
        "style": ["锋利", "减法"],
        "timeout": 300,
        "retries": 2,
    },
    {
        "key": "distribution",
        "role": "分发策略师",
        "method": "分发是创作的一部分: 平台节奏、钩子位置、克制收尾；禁止任何评论/点赞/关注/转发引导话术",
        "model": "deepseek-chat",
        "style": ["平台感", "克制"],
        "timeout": 300,
        "retries": 2,
    },
]

# 内置 agent 工序的默认 LLM 配置（seed 到 phases 表；工序库可编辑）。
# 由 DEFAULT_AGENTS 派生——role/method/style/model/timeout/retries 全量，
# 声明与执行必须一致（AXIOM §1.2：engine 回退到同一来源）。
DEFAULT_AGENT_CONFIG: dict[str, dict] = {
    a["key"]: {k: a.get(k, "") for k in ("role", "method", "style", "model", "timeout", "retries")}
    for a in DEFAULT_AGENTS
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
