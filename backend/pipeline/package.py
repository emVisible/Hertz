"""Bilibili 中文包装生成（v0.8.5，对齐原项目 Autarkeia pipeline/script.py + title.py）。

produce 阶段自动补齐 bili_title（中文 ≤40 字）/ bili_tags（4-8 中文标签）/
bili_desc（中文字幕首句 + 署名），LLM 失败一律 heuristic 兜底，绝不阻塞生产。
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

# Never ship these as Bilibili tags (platform / source noise).
_BANNED_TAG_EXACT = {
    "reddit",
    "redd it",
    "r",
    "subreddit",
    "海外精选",
    "精选",
    "海外",
}
_BANNED_TAG_PREFIXES = ("r/", "u/")

# Heuristic fallback tags (Autarkeia heritage)
_FALLBACK_TAGS = ["神奇现象", "高能", "趣味"]


def _heuristic_bili_title(title: str) -> str:
    """Fallback 中文标题：一行自然短句，不用 A：B 模板（原项目移植）。"""
    short = re.sub(r"\s+", " ", (title or "").strip())
    short = re.sub(r"^\[.*?\]\s*", "", short)
    cjk = sum(1 for ch in short if "\u4e00" <= ch <= "\u9fff")
    if cjk >= 4:
        return short[:40]
    core = short[:28].rstrip(" .,!?:;|-")
    if not core:
        return "这镜头有点东西"
    return f"这镜头 {core}"[:40]


def _is_banned_tag(tag: str) -> bool:
    """B 站标签禁词过滤（原项目移植）：reddit / r/xxx / 纯英文子名等。"""
    t = tag.strip()
    if not t:
        return True
    low = t.lower()
    if low in _BANNED_TAG_EXACT:
        return True
    if any(low.startswith(p) for p in _BANNED_TAG_PREFIXES):
        return True
    # 纯 CamelCase 英文子版块名（如 "BeAmazed"/"nextfuckinglevel"）→ 剔除
    if re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{2,32}", t) and t[0].isupper():
        if not re.search(r"[\u4e00-\u9fff]", t):
            return True
    return False


def normalize_tags(raw: list) -> list[str]:
    """清洗标签：去禁词、去重、限 8 个、每项 ≤20 字。"""
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        tag = str(t or "").strip()
        if not tag or _is_banned_tag(tag):
            continue
        key = tag.lower().replace(" ", "")
        if key in seen:
            continue
        seen.add(key)
        out.append(tag[:20])
        if len(out) >= 8:
            break
    return out


def heuristic_packaging(item) -> dict:
    """无 LLM 时的包装兜底：中文标题 + 默认标签 + 署名简介。"""
    title = _heuristic_bili_title(item.title or "")
    desc = build_description("", item.subreddit or "", item.author or "")
    return {
        "bili_title": title,
        "bili_desc": desc,
        "bili_tags": ",".join(_FALLBACK_TAGS),
    }


def build_description(
    subtitle_zh: str, subreddit: str, author: str | None
) -> str:
    """B 站简介（原项目 build_description 移植）：中文字幕首句 + 署名。

    绝不 dump 英文旁白；B 站转载已挂来源链，正文只保留一句中文亮点。
    """
    zh = (subtitle_zh or "").strip().replace("\n", " ")
    if zh:
        for sep in ("。", "！", "？"):
            idx = zh.find(sep)
            if 6 <= idx <= 72:
                zh = zh[: idx + 1]
                break
        else:
            zh = zh[:72].rstrip()
            if len((subtitle_zh or "").strip()) > 72:
                zh += "…"
    lines: list[str] = []
    if zh:
        lines.append(zh)
    credit = f"r/{subreddit}" if subreddit else ""
    if author:
        credit += f" · u/{author}"
    if credit:
        lines.append(credit)
    return "\n".join(lines)


async def generate_packaging(ai, item, script: dict) -> dict:
    """为条目生成 B 站中文包装，就地补齐 script（bili_title/bili_desc/bili_tags）。

    已存在的手动值不覆盖（发布卡可随时改）；LLM 失败走 heuristic。
    """
    script = dict(script or {})
    if script.get("bili_title") and script.get("bili_tags"):
        return script

    narration = str(script.get("narration") or "")[:800]
    subtitle_zh = str(script.get("subtitle_zh") or "")
    try:
        result = await ai.title_and_tags(
            script=narration, content=f"{item.title}\n\n来源: r/{item.subreddit}"
        )
        title = (result.title or "").strip()
        tags = normalize_tags(result.tags)
        desc = (result.description or "").strip()
        logger.info(
            "packaging via llm: title=%s tags=%s desc=%s", title[:20], tags, desc[:30]
        )
    except Exception:  # noqa: BLE001 — 包装失败兜底，不阻塞生产
        logger.exception("packaging generation failed, using heuristic")
        title, tags, desc = "", [], ""

    if not title:
        title = _heuristic_bili_title(item.title or "")
    if not tags:
        tags = list(_FALLBACK_TAGS)
    if not desc:
        desc = build_description(subtitle_zh, item.subreddit or "", item.author or "")

    script["bili_title"] = title[:40]
    script["bili_desc"] = desc
    script["bili_tags"] = ",".join(tags)
    return script
