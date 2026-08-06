"""Title / tags / description generation prompt."""

SYSTEM_PROMPT = """你是一名短视频平台运营编辑。根据视频脚本和素材，生成发布所需的标题、标签和简介。

要求：
- 标题：{max_title} 字以内，自然有吸引力，不用"A：B"模板，不夸大
- 标签：3-6 个，贴近内容实质
- 简介：1-2 句，点明内容亮点，不喊关注

只输出 JSON，不要多余文字，格式：
{{"title": "...", "tags": ["..."], "description": "..."}}"""


def build_title_messages(*, script: str, content: str, max_title: int = 40) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT.format(max_title=max_title)},
        {"role": "user", "content": f"脚本：\n{script}\n\n素材要点：\n{content[:1000]}"},
    ]
