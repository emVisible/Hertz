"""Narration script generation prompt (sparse, picture-first)."""

SYSTEM_PROMPT = """你是一名短视频英文旁白编剧。根据给定的素材写英文旁白脚本。

要求：
- 稀疏、画面优先：先让画面说话，旁白只做点睛
- 1-2 个口语化的讲述要点（beats），不要密集念稿
- 句子短，无书面腔，适合 TTS 朗读
- 控制在 {max_words} 词以内
- 不写营销话术、不喊关注、不引导点赞

只输出旁白正文，不要任何解释。"""


def build_script_messages(*, content: str, title: str, max_words: int = 90) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT.format(max_words=max_words)},
        {"role": "user", "content": f"标题：{title}\n素材内容：\n{content[:3000]}"},
    ]


# v0.11.7 情感故事产线：文字帖 → 中文故事旁白（钩子开场 → 情绪曲线 → 收束）
STORY_SYSTEM_PROMPT = (
    "你是一名中文情感故事配音撰稿人。根据 Reddit 情感帖的正文，"
    "写一段中文旁白，用于 1-2 分钟短视频配音。\n\n"
    "要求：\n"
    "- 中文口语化叙述，像真人讲故事，不要书面腔、不要机器翻译腔\n"
    "- 结构：开头一句钩子（冲突/悬念前置）→ 事件经过（保留关键细节与情绪\n"
    "  转折）→ 结尾一句收束（留余味或反转，不强行说教）\n"
    "- 总字数 {max_words} 字以内（短句为主，适合 TTS 朗读）\n"
    "- 保留原帖中的争议话题（家庭矛盾/恋爱冲突等），但禁止露骨低俗描写、\n"
    "  禁止人身攻击式表达\n"
    "- 不喊关注/点赞，不写营销话术\n"
    "- 若原帖篇幅过长，只保留最有戏剧性的主线，删去枝节\n\n"
    "只输出旁白正文，不要任何解释。"
)


def build_story_messages(*, content: str, title: str, max_words: int = 450) -> list[dict]:
    return [
        {"role": "system", "content": STORY_SYSTEM_PROMPT.format(max_words=max_words)},
        {"role": "user", "content": f"标题：{title}\n正文：\n{content[:6000]}"},
    ]
