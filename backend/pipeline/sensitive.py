"""Sensitive-word compliance check (Mojito heritage).

三级过滤：Tier1 违禁词 → 阻断（内容不可发布）；Tier2 广告法/夸大词 →
告警并脱敏建议；Tier3 弱提示词 → 提示。词表为内置精简版，覆盖
广告法极限词（最/第一/顶级/国家级）、医疗承诺、金融承诺与内容平台
常见违禁（赌博、色情、暴力）。

AXIOM §22.1：合规是发布前的硬门禁，宁可误杀不可漏放。
"""

Tier1 = {
    # 极限词/广告法
    "最", "第一", "顶级", "国家级", "世界级", "绝无仅有", "100%", "百分之百",
    # 医疗承诺
    "包治", "根治", "治愈率", "药到病除", "减肥神药", "抗癌",
    # 金融承诺
    "稳赚", "保本", "零风险", "一夜暴富", "内幕消息",
    # 内容平台违禁
    "赌博", "博彩", "色情", "嫖娼", "毒品", "枪支持有", "洗钱",
}
Tier2 = {
    "唯一", "顶尖", "领先", "极致", "完美", "史上", "全球首创",
    "有效率", "治疗", "贷款", "理财", "投资回报",
}
Tier3 = {
    "免费领取", "点击领取", "转发抽奖", "加微信", "加V", "私信领取",
}

_REPLACEMENT = "▢"


def check_text(text: str) -> dict:
    """Return {tier1: [words], tier2: [words], tier3: [words]}."""
    hits = {"tier1": [], "tier2": [], "tier3": []}
    for word in Tier1:
        if word in text:
            hits["tier1"].append(word)
    for word in Tier2:
        if word in text and word not in hits["tier1"]:
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


def check_script(script: dict) -> dict:
    """Check a produced script (narration/title/subtitle fields)."""
    fields = ["narration", "title", "subtitle_zh", "cover_text", "bili_title"]
    combined: dict = {"tier1": [], "tier2": [], "tier3": []}
    for field in fields:
        value = script.get(field)
        if not isinstance(value, str):
            continue
        hits = check_text(value)
        for tier in ("tier1", "tier2", "tier3"):
            for word in hits[tier]:
                if word not in combined[tier]:
                    combined[tier].append(word)
    return combined
