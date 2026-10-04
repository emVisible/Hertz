"""评分器到底看了什么（v0.34 D-222）。

从前 `ScoreStep` 传给评分模型的 `content` 是硬拼的两行 `subreddit / score`，而 prompt
把它标成「内容：」——于是**标题 + reddit 热度被当成故事正文打了分**，八维里的
`completion`（有没有头有尾）、`emotion`（情绪价值）都是在评一个不存在的输入，
而 `score_reasons` 里没有任何一句话说明这件事。

这四条腿钉的是：有正文就真把正文送进去；没有正文就照实记 `basis="title_only"`；
超长要截断（成本闸门）；规则引擎那条路也标同一个字段（不许只有 LLM 路说实话）。
"""

import pytest

from backend.models.item import Item
from backend.pipeline.steps.score import SCORE_BODY_CHARS, ScoreStep, score_input


def _item(**kw) -> Item:
    base = dict(
        status="discovered",
        source="reddit",
        source_id=f"d222-{id(kw)}",
        title="My husband hid his student loans",
        subreddit="AITA",
        reddit_score=800,
        upvote_ratio=0.93,
        # 内存里构造的 Item 不会应用列默认值（那是 INSERT 时的事），而启发式评分
        # 直接对 num_comments 做数学——库里 5,281 行零个 NULL，所以缺这个数只是替身不全。
        num_comments=0,
        selftext="",
    )
    base.update(kw)
    return Item(**base)


# ---------- 纯函数：唯一作者 ----------


def test_score_input_uses_the_body_when_there_is_one() -> None:
    body = "I found the papers in a drawer. " * 6  # 远超 MIN_STORY_CHARS=50
    content, basis = score_input(_item(selftext=body))
    assert basis == "body"
    assert "正文：" in content
    assert body[:40] in content
    # 热度上下文仍然带着（它是有用的辅助信息），但不能冒充内容
    assert "subreddit: AITA" in content


def test_score_input_marks_title_only_when_the_body_is_missing() -> None:
    content, basis = score_input(_item(selftext="   "))
    assert basis == "title_only"
    assert "正文" not in content, "没有正文还要画「正文：」这一栏，就是让模型对着空气打分"

    # 短到不算故事的（< MIN_STORY_CHARS）同样标 title_only——阈值作者仍是 quality，不复制数字
    short, short_basis = score_input(_item(selftext="too short"))
    assert short_basis == "title_only"
    assert short == content


def test_score_input_truncates_a_long_body() -> None:
    body = "x" * (SCORE_BODY_CHARS + 5_000)
    content, basis = score_input(_item(selftext=body))
    assert basis == "body"
    assert body[:SCORE_BODY_CHARS] in content
    assert body.count("x") - SCORE_BODY_CHARS > 1_000  # 尾部确实没全进来
    assert len(content) < SCORE_BODY_CHARS + 200, f"截断没生效：{len(content)}"


# ---------- 步骤：两条路都要说实话 ----------


class _Settings:
    pipeline_score_max_per_run = 100
    pipeline_score_max_per_day = 1000
    pipeline_min_score = 6.0
    pipeline_prefilter_min_reddit_score = 50
    pipeline_prefilter_min_upvote_ratio = 0.85
    pipeline_heuristic_scoring = False


class _Ai:
    llm_available = True

    def __init__(self, dims) -> None:
        self.dims = dims
        self.calls: list[dict] = []

    async def score(self, **kwargs):
        self.calls.append(kwargs)
        dims = self.dims

        class R:
            total = 9.9  # LLM 自报高分——不采信
            dimensions = dims
            reasons: list[str] = []
            fallback = False

        return R()


class _Ctx:
    def __init__(self, settings, ai) -> None:
        self.settings = settings
        self.ai = ai
        self.scores_used = 0

    def log(self, message, level="info"):
        pass


@pytest.mark.asyncio
async def test_llm_path_receives_the_body_and_records_basis() -> None:
    ai = _Ai({"entertainment": 8.0, "emotion": 9.0, "safety": 8.0})
    item = _item(selftext="She left the funeral early, and nobody asked why for eleven years. " * 2)
    result = await ScoreStep().process(_Ctx(_Settings(), ai), item)

    assert ai.calls, "评分模型一次都没被调用"
    assert "funeral" in ai.calls[0]["content"], "正文没进请求——还是在给标题+热度打分"
    assert result.status == "scored"
    assert result.data["score_dimensions"]["basis"] == "body"
    assert any("正文" in r for r in result.data["score_reasons"])


@pytest.mark.asyncio
async def test_llm_path_records_title_only_instead_of_pretending() -> None:
    ai = _Ai({"entertainment": 8.0, "emotion": 9.0, "safety": 8.0})
    result = await ScoreStep().process(_Ctx(_Settings(), ai), _item(selftext=""))

    assert result.status == "scored"
    assert result.data["score_dimensions"]["basis"] == "title_only"
    assert any("title_only" in r or "无正文" in r for r in result.data["score_reasons"]), (
        "理由里看不出这次评分没读过正文——那界面就会把它当内容质量分用"
    )


@pytest.mark.asyncio
async def test_heuristic_path_marks_the_same_basis() -> None:
    """规则引擎只看热度与标题，它也必须标同一个字段——不然只有 LLM 那条路说实话。"""
    class HeuristicSettings(_Settings):
        pipeline_heuristic_scoring = True

    ai = _Ai({"entertainment": 8.0})
    # reddit_score 很高 + ratio 很高 → 启发式落在灰区之外，直接出分（不调 LLM）
    item = _item(reddit_score=9000, upvote_ratio=0.99, selftext="")
    result = await ScoreStep().process(_Ctx(HeuristicSettings(), ai), item)

    assert ai.calls == [], "高置信条目应该走规则引擎，不该花 API"
    assert result.status == "scored"
    assert result.data["score_dimensions"]["engine"] == "heuristic"
    assert result.data["score_dimensions"]["basis"] == "title_only"
