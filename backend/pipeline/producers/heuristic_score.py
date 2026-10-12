"""启发式评分引擎（v0.25）：多信号规则打分，LLM 仅灰区增强。

设计目标：将评分 API 调用减少 ≥70%——高置信条目（规则分明确高于/低于
阈值）自动定级，仅灰区条目（±0.5 内）调用 LLM 精评。

信号源（全部零 API 成本）：
- 社区认可：reddit_score / upvote_ratio / num_comments 归一化加权
- 内容新鲜度：created_utc 指数衰减（越新越高分，半衰期 3 天，见 _FRESHNESS_HALF_LIFE_S）
- 标题吸引力：长度适中(20-80 字符) + 含数字/疑问/情感词加分
- 类型匹配：video_raw 基础分 > text_only（视觉内容优先）

输出格式与 LLM 评分对齐（dimensions dict + total），下游零改动。
"""

import math
import re
from datetime import UTC, datetime

#: 新鲜度半衰期（秒）= 3 天。
#:
#: v0.37 之前这个值是裸的 259_200，而**模块文档写着「7 天半衰期」**——两处矛盾。
#: 代码与函数 docstring 都是 3 天，所以真相是 3 天、文档写错了。改成具名常量：
#: 一个读不懂的魔数下次被「修正」时，没人会同时去改文档。
_FRESHNESS_HALF_LIFE_S = 259_200

# 各信号权重（合计 1.0）
_W_COMMUNITY = 0.30
_W_FRESHNESS = 0.20
_W_TITLE = 0.25
_W_TYPE = 0.15
_W_ENGAGEMENT = 0.10

# 标题吸引力关键词
_POSITIVE_HINTS = re.compile(
    r"\d|[?!]|amazing|incredible|insane|beautiful|satisfying|wholesome"
    r"|精彩|震撼|治愈|温暖|搞笑|绝了|居然|竟然",
    re.I,
)
_NEGATIVE_HINTS = re.compile(r"nsfw|spoiler|politics|trump|war|死亡|暴力", re.I)

_OPTIMAL_TITLE_LEN = (20, 80)


def _norm(value: float, lo: float, hi: float) -> float:
    """线性归一到 [0,1]，超范围截断。"""
    if hi <= lo:
        return 0.5
    return max(0.0, min((value - lo) / (hi - lo), 1.0))


def _freshness_score(created_utc: float, now_ts: float) -> float:
    """指数衰减：半衰期 3 天。"""
    age_s = max(now_ts - created_utc, 0)
    return math.pow(0.5, age_s / _FRESHNESS_HALF_LIFE_S)


def _title_score(title: str) -> float:
    """标题吸引力：长度适中 + 含吸引词加分 + 含负面词减分。"""
    length = len(title)
    base = 0.4
    # 长度在最优区间 → 加分
    if _OPTIMAL_TITLE_LEN[0] <= length <= _OPTIMAL_TITLE_LEN[1]:
        base += 0.2
    elif length < 10:
        base -= 0.15
    # 吸引词
    if _POSITIVE_HINTS.search(title):
        base += 0.15
    if _NEGATIVE_HINTS.search(title):
        base -= 0.15
    return max(0.0, min(base, 1.0))


def heuristic_score(
    *,
    reddit_score: int = 0,
    upvote_ratio: float = 1.0,
    num_comments: int = 0,
    title: str = "",
    item_type: str = "video_raw",
    created_utc: float = 0.0,
) -> tuple[float, dict[str, float]]:
    """多信号规则评分。返回 (total_0_to_10, dimensions_dict)。

    与 LLM 评分输出结构对齐（score_dimensions/score_total），
    下游消费方零改动。
    """
    now = datetime.now(UTC).timestamp()

    community = (
        _norm(math.log1p(max(reddit_score, 0)), 0, 500) * 0.6
        + upvote_ratio * 0.4
    )
    engagement = _norm(math.log1p(max(num_comments, 0)), 0, 100)
    freshness = _freshness_score(created_utc, now)
    title_q = _title_score(title)
    type_bonus = 0.8 if item_type == "video_raw" else 0.5

    dimensions = {
        "community": round(_norm(community, 0, 1) * 10, 1),
        "freshness": round(freshness * 10, 1),
        "title_quality": round(title_q * 10, 1),
        "type_match": round(type_bonus * 10, 1),
        "engagement": round(engagement * 10, 1),
    }

    total = (
        community * _W_COMMUNITY * 10
        + freshness * _W_FRESHNESS * 10
        + title_q * _W_TITLE * 10
        + type_bonus * _W_TYPE * 10
        + engagement * _W_ENGAGEMENT * 10
    )
    total = round(max(0.0, min(total, 10.0)), 1)
    dimensions["heuristic_total"] = total

    return total, dimensions


def is_gray_zone(total: float, threshold: float = 6.0, margin: float = 0.5) -> bool:
    """规则分处于灰区 → 需要 LLM 增强；否则直接采用规则结论。"""
    return abs(total - threshold) <= margin
