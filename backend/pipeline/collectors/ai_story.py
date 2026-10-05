"""AI 原创故事源（v0.22 非破坏性扩展）：LLM 直产文字故事种子。

定位：Reddit text_only 产线的替代供料通道——零外部凭证，走已配置的
LLM Provider（fast 池）。产出与 Reddit 文字帖同构的 RawPost
（item_type="text_only" + selftext），下游 LLM 中文旁白 → edge-tts →
图文合成整条复用（media.py 故事分支），零改动。

成本闸：单次采集最多生成 ``pipeline_ai_story_per_tick`` 条（默认 2，
防 auto_collect tick 放大费用）；生成失败/过短抛错 → 走既有失败分类+冷却。
标题查重由评分阶段 find_title_duplicate 兜底（同 Reddit 文字帖）。

通道格式：``ai-story/<主题方向>``（如 ai-story/情感夜话）——主题仅作为
选题提示注入 prompt；栏目化绑定（人设/题材池）在 M2 栏目实体接入。
"""

import json
import logging
import re
import time
import uuid

from backend.ai.types import ChatMessage
from backend.config import settings as app_settings
from backend.pipeline.collectors.base import RawPost, SourceCollector

logger = logging.getLogger(__name__)

# 单条故事下限：对齐 Reddit 文字帖入库门槛（v0.11.7 selftext ≥50 字）
MIN_STORY_CHARS = 50
MAX_STORY_CHARS = 1200

_STORY_SYSTEM = (
    "你是中文情感故事作者，为治愈系短视频频道供稿。"
    "写作要求：\n"
    "① 第一人称或贴近人物的第三人称叙事，有具体的场景与细节；\n"
    "② 有清晰的情绪弧线（铺垫→转折→落点），结尾留有余味不说教；\n"
    "③ 口语化、短句为主，适合朗读；300-600 字；\n"
    "④ 只写日常生活里真实可信的情感故事（亲情/爱情/友情/陌生人善意），"
    "不写灵异、政治、性、暴力内容。\n"
    "输出严格 JSON：{\"title\": \"…\", \"story\": \"…\"}，无其他内容。"
)

_STORY_USER = (
    "本期选题方向：【{theme}】。\n"
    "请围绕该方向原创一篇全新的情感故事（不要复述任何已有作品），"
    "按系统要求输出 JSON。title ≤ 24 字。"
)

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def _parse_story(text: str) -> tuple[str, str]:
    """LLM 输出 → (title, story)；解析失败/过短抛错（调用方记采集失败）。"""
    match = _JSON_RE.search(text or "")
    if not match:
        raise RuntimeError(f"story seed 输出非 JSON: {text[:120]}")
    # strict=False：允许字符串值里出现裸控制字符（D-224）。故事按要求分段写，
    # 段落之间就是真换行，而 JSON 默认严格模式把 `"...第一段\n\n第二段"` 判成非法——
    # 表现是"故事一旦分段就永远采不进来"，不是偶发解析失败。
    data = json.loads(match.group(0), strict=False)
    title = str(data.get("title") or "").strip()
    story = str(data.get("story") or "").strip()
    if len(story) < MIN_STORY_CHARS:
        raise RuntimeError(f"生成的故事过短（{len(story)} 字 < {MIN_STORY_CHARS}）")
    if not title:
        title = story[:20]
    return title[:80], story[:MAX_STORY_CHARS]


class AIStoryCollector(SourceCollector):
    """LLM 直产文字故事种子（零外部依赖，成本闸内运行）。"""

    name = "ai-story"

    def __init__(self, ai=None) -> None:
        self._ai = ai

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        if self._ai is None or not getattr(self._ai, "llm_available", False):
            raise RuntimeError("LLM provider 未配置——ai-story 源不可用")
        _, theme = channel.split("/", 1) if "/" in channel else ("", channel)
        theme = theme.strip() or "情感夜话"
        per_tick = max(1, int(getattr(app_settings, "pipeline_ai_story_per_tick", 2) or 2))
        count = max(1, min(int(limit or 1), per_tick))

        # 栏目人设（v0.22）：通道归属栏目且有 persona_prompt 时覆盖默认人设
        system_prompt = _STORY_SYSTEM
        try:
            from backend.pipeline.helpers import find_channel_for_source

            channel_entity = await find_channel_for_source(channel)
            if channel_entity is not None and (channel_entity.persona_prompt or "").strip():
                system_prompt = (
                    f"{_STORY_SYSTEM}\n【栏目人设与风格（优先遵循）】\n"
                    f"{channel_entity.persona_prompt.strip()}"
                )
        except Exception:  # noqa: BLE001 — 人设解析失败回落默认
            logger.warning("persona resolve failed, using default", exc_info=True)

        posts: list[RawPost] = []
        for i in range(count):
            title, story = await self._generate_once(ctx, theme, system_prompt)
            posts.append(
                RawPost(
                    source_id=uuid.uuid4().hex[:16],
                    title=title,
                    source_url="",
                    author="ai-original",
                    created_utc=time.time(),
                    is_video=False,
                    item_type="text_only",
                    selftext=story,
                )
            )
            ctx.log(f"[ai-story] ({i + 1}/{count}) {title}")
        return posts

    async def _generate_once(self, ctx, theme: str, system_prompt: str) -> tuple[str, str]:
        messages = [
            ChatMessage(role="system", content=system_prompt),
            ChatMessage(role="user", content=_STORY_USER.format(theme=theme)),
        ]
        text = await self._ai.chat_messages(
            messages,
            temperature=0.9,
            max_tokens=1500,
            role="fast",
            operation="story_seed",
            caller="pipeline",
        )
        try:
            return _parse_story(text)
        except (ValueError, RuntimeError) as exc:
            logger.warning("ai-story generation failed: %s", exc)
            raise RuntimeError(f"AI 故事生成失败: {exc}") from exc
