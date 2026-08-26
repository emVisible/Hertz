"""Sensitive-word compliance check (Mojito heritage).

三级过滤：Tier1 违禁词 → 阻断（内容不可发布）；Tier2 广告法/夸大词 →
告警并脱敏建议；Tier3 弱提示词 → 提示。词表为内置精简版，覆盖
广告法极限词（最/第一/顶级/国家级）、医疗承诺、金融承诺与内容平台
常见违禁（赌博、色情、暴力）。

AXIOM §22.1：合规是发布前的硬门禁，宁可误杀不可漏放。

v0.11.7：Tier1 拆两类——营销极限词（广告法，标题/简介场景适用）与
安全红线（内容平台违禁，任何文本场景都硬拒）。中文故事旁白（情感
频道文字产线）天然含「最/第一」等口语词，按完整 Tier1 会全量误杀，
故故事场景用 safety_only=True：安全红线阻断，营销词降级为 tier2 告警。
"""

from backend.models.script_keys import (
    BILI_TITLE as _SK_BILI_TITLE,
)
from backend.models.script_keys import (
    NARRATION as _SK_NARRATION,
)
from backend.models.script_keys import (
    SUBTITLE_ZH as _SK_SUBTITLE_ZH,
)

# 安全红线（内容平台违禁）：任何文本命中即阻断
TIER1_SAFETY = {
    "赌博", "博彩", "色情", "嫖娼", "毒品", "枪支持有", "洗钱",
}

# 营销极限词（广告法/医疗/金融承诺）：标题、简介等营销文案场景阻断
TIER1_MARKETING = {
    "最", "第一", "顶级", "国家级", "世界级", "绝无仅有", "100%", "百分之百",
    "包治", "根治", "治愈率", "药到病除", "减肥神药", "抗癌",
    "稳赚", "保本", "零风险", "一夜暴富", "内幕消息",
}

Tier1 = TIER1_SAFETY | TIER1_MARKETING  # 兼容既有引用（check_text 默认全量）
Tier2 = {
    "唯一", "顶尖", "领先", "极致", "完美", "史上", "全球首创",
    "有效率", "治疗", "贷款", "理财", "投资回报",
}
Tier3 = {
    "免费领取", "点击领取", "转发抽奖", "加微信", "加V", "私信领取",
}

_REPLACEMENT = "▢"


def check_text(text: str, *, safety_only: bool = False) -> dict:
    """Return {tier1: [words], tier2: [words], tier3: [words]}.

    safety_only=True：tier1 只算安全红线；营销极限词降级进 tier2（告警不阻断）。
    """
    hits = {"tier1": [], "tier2": [], "tier3": []}
    tier1_words = TIER1_SAFETY if safety_only else Tier1
    for word in tier1_words:
        if word in text:
            hits["tier1"].append(word)
    extra_tier2 = TIER1_MARKETING if safety_only else set()
    for word in (*Tier2, *extra_tier2):
        if word in text and word not in hits["tier1"] and word not in hits["tier2"]:
            hits["tier2"].append(word)
    for word in Tier3:
        if word in text:
            hits["tier3"].append(word)
    return hits


def redact(text: str) -> str:
    """Replace all hit words with ▢ (best-effort redaction)."""
    out = text
    for word in (*Tier1, *Tier2, *Tier3):
        out = out.replace(word, _REPLACEMENT)
    return out


def check_script(script: dict, *, safety_only: bool = False) -> dict:
    """Check a produced script (narration/title/subtitle fields)."""
    fields = [_SK_NARRATION, "title", _SK_SUBTITLE_ZH, "cover_text", _SK_BILI_TITLE]
    combined: dict = {"tier1": [], "tier2": [], "tier3": []}
    for field in fields:
        value = script.get(field)
        if not isinstance(value, str):
            continue
        hits = check_text(value, safety_only=safety_only)
        for tier in ("tier1", "tier2", "tier3"):
            for word in hits[tier]:
                if word not in combined[tier]:
                    combined[tier].append(word)
    return combined
