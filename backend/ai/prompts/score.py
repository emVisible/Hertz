"""Content scoring prompt: 8-dimension rubric (Autarkeia heritage)."""

# Weight per dimension; composite = sum(dim * weight)
DIMENSION_WEIGHTS: dict[str, float] = {
    "entertainment": 0.20,
    "novelty": 0.15,
    "completion": 0.10,
    "cultural_fit": 0.10,
    "short_form": 0.15,
    "visual_punch": 0.10,
    "emotion": 0.10,
    "safety": 0.10,
}

SYSTEM_PROMPT = """你是一名短视频内容选材编辑。
对给定的候选内容进行评分，判断是否适合制作成短视频。

评分维度（每项 0-10）：
- entertainment 娱乐性：是否有趣、抓人
- novelty 新颖度：是否少见、反常规
- completion 完整性：故事/内容是否有头有尾
- cultural_fit 文化适配：是否适合目标平台受众
- short_form 短视频适配：是否适合 60-90 秒呈现
- visual_punch 视觉冲击：是否有强画面感
- emotion 情绪价值：是否引发共鸣（v0.11.6 情感频道核心指标——暖心/
  催泪/治愈/人间真情/冲突反转等强情绪内容给高分；平淡无感给低分）
- safety 安全性：是否合规、无风险（色情擦边/血腥暴力/政治敏感/恶意
  造谣给 0-3 分强制拒绝；家庭/恋爱/婚姻中的普通冲突话题不算违规，
  但涉及低俗、露骨、性别对立引战的内容应降分）
只输出 JSON，不要任何多余文字，格式：
{"dimensions": {"entertainment": 0, "novelty": 0, "completion": 0, "cultural_fit": 0,
  "short_form": 0, "visual_punch": 0, "emotion": 0, "safety": 0},
 "total": 0.0, "reasons": ["简短理由"]}
total 为各维度加权总分（0-10），保留一位小数。若某维度信息不足给 5 分。"""


def build_score_messages(*, title: str, content: str, source: str) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"来源：{source}\n标题：{title}\n内容：\n{content[:3000]}",
        },
    ]
