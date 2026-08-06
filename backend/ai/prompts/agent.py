"""Agent phase prompts — role, methodology, context and task assembly.

Mirrors the Mojito crew role prompts. Each agent phase receives:
role / methodology / platform hints / brief excerpt / prior outputs
as context, and must deliver the finished artifact directly.

v2.4：系统提示词可从模板库覆盖（templates 参数 = {key: content}，
由调用方（engine）在运行开始时取一次；不传则用出厂默认）。
"""

from backend.ai.prompts import templates as factory
from backend.ai.types import ChatMessage

# 前序产物必须完整传导: 800 字会把导演的分析截断成"提示语"，agent 无法真正理解输入
# （AXIOM §34 — context 是理解的前提，不是装饰）。
_PRIOR_FULL_LEN = 8000
_PRIOR_HEAD_LEN = _PRIOR_FULL_LEN

# 每次任务的隐性要求：输入是原料，不是答案。禁止把输入原文重排/换词后交差。
# 出厂默认在 templates.py；模板库可覆盖（key: agent.thinking_protocol）。
_THINKING_PROTOCOL = factory.get_default("agent.thinking_protocol")


def build_agent_messages(
    *,
    agent: dict,
    phase_name: str,
    topic: str,
    brief_excerpt: str,
    platform_id: str,
    prior: str,
    output_file: str,
    templates: dict[str, str] | None = None,
    buffs: list[dict] | None = None,
) -> list[ChatMessage]:
    thinking = (templates or {}).get("agent.thinking_protocol", _THINKING_PROTOCOL)
    system_tpl = (templates or {}).get("agent.system_template", "")
    role = agent.get("role") or phase_name
    method = agent.get("method") or "直接交付成品"
    style = agent.get("style") or []
    style_line = f"风格标签: {', '.join(style)}。" if style else ""

    # v5.0 buff 注入：正向 buff →【附加要求】；反向 debuff →【禁忌】（v5.2）
    buff_lines = ""
    debuff_lines = ""
    if buffs:
        pos = [b for b in buffs if b.get("polarity") != "debuff" and b.get("effect")]
        neg = [b for b in buffs if b.get("polarity") == "debuff" and b.get("effect")]
        if pos:
            buff_lines = "\n".join(f"【{b['name']}】{b['effect']}" for b in pos)
            buff_lines = f"\n\n【附加要求】\n{buff_lines}\n"
        if neg:
            debuff_lines = "\n".join(f"【{b['name']}】{b['effect']}" for b in neg)
            debuff_lines = f"\n\n【禁忌】\n{debuff_lines}\n"
    extra = buff_lines + debuff_lines

    if system_tpl:
        system = system_tpl.format(
            role=role,
            style_line=style_line,
            method=method,
            brief=brief_excerpt[:1200],
            platform=platform_id or "未指定",
            thinking_protocol=thinking,
        ) + extra
    else:
        system = (
            f"You are: {role}。{style_line}{method}\n"
            f"【策略】{brief_excerpt[:1200]}\n"
            f"【平台】{platform_id or '未指定'}\n"
            "Do not ask questions. Proceed autonomously and deliver the final "
            "output directly in Chinese Markdown.\n"
            f"{thinking}"
            f"{extra}"
        )

    parts = [f"任务阶段: {phase_name}", f"主素材: {topic}"]
    if prior:
        parts.append(f"前序产物（先读懂，再决定怎么用，勿复制）:\n{prior[:_PRIOR_HEAD_LEN]}")
    parts.append(
        f"输出要求: 直接给出成品内容（Markdown），输出到 {output_file}，不要解释过程。"
    )

    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content="\n\n".join(parts)),
    ]


# 兼容旧常量引用（出厂默认；模板库覆盖时以 DB 为准）
SYNTHESIS_SYSTEM = factory.get_default("synthesis.system")
BRIEF_SYSTEM = factory.get_default("brief.system")


def build_brief_messages(
    *,
    topic: str,
    brief_excerpt: str,
    platform_id: str,
    templates: dict[str, str] | None = None,
) -> list[ChatMessage]:
    system = (templates or {}).get("brief.system", factory.get_default("brief.system"))
    parts = [
        f"输入素材: {topic}",
        f"【平台】{platform_id or '未指定'}",
    ]
    if brief_excerpt:
        parts.append(f"【已有策略】\n{brief_excerpt[:1200]}")
    parts.append(
        "要求: 输出创意策略（Markdown），包含【素材本质】【中心主张】【结构骨架】"
        "【可挖的延伸】【禁忌与取舍】五个小节。不要复述素材原文。"
    )
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content="\n\n".join(parts)),
    ]


def build_synthesis_messages(
    *,
    topic: str,
    title: str,
    brief_excerpt: str,
    platform_id: str,
    body: str,
    visual: str = "",
    distribution: str = "",
    mode: str = "text",
    templates: dict[str, str] | None = None,
) -> list[ChatMessage]:
    system = (templates or {}).get("synthesis.system", factory.get_default("synthesis.system"))
    mode_label = {"text": "图文", "visual": "视觉", "video": "视频"}.get(mode, mode)
    parts = [
        f"标题: {title}",
        f"主题: {topic}",
        f"【创作模式】{mode_label}",
        f"【策略】{brief_excerpt[:1200]}",
        f"【平台】{platform_id or '未指定'}",
        f"【正文草稿】（素材，不是最终文字）\n{body[:4000]}",
    ]
    if visual:
        parts.append(f"【视觉方案】\n{visual[:1500]}")
    if distribution:
        parts.append(f"【分发建议】\n{distribution[:1500]}")
    parts.append(
        "要求: 以正文草稿为素材重写为成品：开头直接进入内容（标题由编辑器负责），"
        "删除重复与废话，结构上要有递进；结尾干净收束，不写任何评论/点赞/关注引导，"
        "不写\"评论区聊聊\"\"转给谁\"之类的互动话术。"
        "不得把草稿段落原样拼接成文。"
    )
    if mode == "visual":
        parts.append("创作模式为视觉：视觉方案/配图章节放在正文之前，正文紧随其后。")
    elif mode == "video":
        parts.append("创作模式为视频：把镜头/视觉/分镜相关内容提前到正文之前。")
    parts.append(
        "高亮要求: 用 Markdown 加粗（**...**）标出全文中 1–3 处最值得记住/引用"
        "的金句或结论（供图文发布时高亮展示），数量不要多。"
    )
    return [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content="\n\n".join(parts)),
    ]
