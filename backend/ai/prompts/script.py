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
