"""配音音色选择（v0.8.9，对齐原项目 tts.py pick_voice）：
内容自适应——科技/军事/硬核 → 男声，萌宠/家庭/暖心 → 女声，
奇观类 subreddit 男声偏置 + 随机；手动配置音色（注册表 tts 角色）优先。
"""

import random
import re

# Curated neural voices（edge-tts）。键为稳定风格 id。
VOICE_CATALOG: dict[str, dict[str, str]] = {
    "en-US-AndrewNeural": {"gender": "male", "accent": "us", "style": "clear"},
    "en-US-BrianNeural": {"gender": "male", "accent": "us", "style": "warm"},
    "en-US-GuyNeural": {"gender": "male", "accent": "us", "style": "narrative"},
    "en-US-JennyNeural": {"gender": "female", "accent": "us", "style": "bright"},
    "en-US-AriaNeural": {"gender": "female", "accent": "us", "style": "soft"},
    "en-GB-RyanNeural": {"gender": "male", "accent": "uk", "style": "crisp"},
    "en-GB-SoniaNeural": {"gender": "female", "accent": "uk", "style": "warm"},
    "en-AU-WilliamNeural": {"gender": "male", "accent": "au", "style": "casual"},
    "en-AU-NatashaNeural": {"gender": "female", "accent": "au", "style": "friendly"},
    "zh-CN-XiaoxiaoNeural": {"gender": "female", "accent": "cn", "style": "bright"},
    "zh-CN-YunxiNeural": {"gender": "male", "accent": "cn", "style": "clear"},
}

_MALE_TECH = re.compile(
    r"\b(tech|science|engine|robot|space|ai|machine|circuit|code|physics|"
    r"military|weapon|drone|nasa|quantum|metal|mech)\b|"
    r"(科技|机械|机器人|航天|军事|工程|电路|金属|硬核)",
    re.I,
)
_FEMALE_WARM = re.compile(
    r"\b(cat|dog|pet|baby|family|mom|dad|love|cute|wholesome|friend|"
    r"wedding|home|cook|garden|rescue|animal)\b|"
    r"(猫|狗|萌|亲子|家庭|暖心|可爱|宠物|救|温馨|日常)",
    re.I,
)

_SPECTACLE_SUBS = {
    "nextfuckinglevel",
    "beamazed",
    "interestingasfuck",
    "damnthatsinteresting",
    "woahdude",
    "unexpected",
    "nonononoyes",
}


def list_voices() -> list[dict[str, str]]:
    return [{"id": vid, **meta} for vid, meta in VOICE_CATALOG.items()]


def pick_voice(
    *,
    title: str = "",
    script: str = "",
    subreddit: str = "",
    tags: list[str] | None = None,
    configured: str | None = None,
) -> tuple[str, str]:
    """Return (voice_id, reason)。手动配置（注册表 tts 角色）优先，除非 auto。"""
    cfg = (configured or "").strip()
    if cfg and cfg.lower() not in ("auto", "random", "smart"):
        if cfg in VOICE_CATALOG or cfg.endswith("Neural"):
            return cfg, "configured"
    blob = " ".join([title or "", script or "", subreddit or "", " ".join(tags or [])])
    male_pool = [v for v, m in VOICE_CATALOG.items() if m["gender"] == "male"]
    female_pool = [v for v, m in VOICE_CATALOG.items() if m["gender"] == "female"]
    if _MALE_TECH.search(blob) and not _FEMALE_WARM.search(blob):
        return random.choice(male_pool), "auto:tech/rational→male"
    if _FEMALE_WARM.search(blob) and not _MALE_TECH.search(blob):
        return random.choice(female_pool), "auto:warm/daily→female"
    spectacle = (subreddit or "").lower() in _SPECTACLE_SUBS
    pool = male_pool + female_pool
    if spectacle:
        pool = male_pool * 2 + female_pool
    else:
        pool = female_pool * 2 + male_pool
    return random.choice(pool), "auto:mixed"
