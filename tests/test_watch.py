"""热点监控通道（v0.16，TrendRadar 词法精华借鉴）契约测试：

1. 三段词法：普通词(任一命中) / +必须词(全部含) / !排除词(含即排除)
2. watch 通道构造与开关语义
3. run_collect(filter_fn=...) 词法预筛——不命中条目不入库
"""

from datetime import UTC, datetime

import pytest

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.watch import matches, parse_keywords, watch_channels

# ---------- 词法解析 ----------


def test_parse_keywords_space_and_comma() -> None:
    assert parse_keywords("cat dog") == ["cat", "dog"]
    assert parse_keywords("cat, dog ,fish") == ["cat", "dog", "fish"]
    assert parse_keywords("") == []
    # 去重保序
    assert parse_keywords("a b a") == ["a", "b"]


def test_matches_three_segment_syntax() -> None:
    # 普通词任一命中即可
    assert matches("cute cat video", any_kw=["cat", "dog"], all_kw=[], exclude_kw=[])
    # 必须词全部满足
    assert not matches(
        "cute cat video", any_kw=[], all_kw=["cat", "dog"], exclude_kw=[]
    )
    assert matches(
        "cat meets dog", any_kw=[], all_kw=["cat", "dog"], exclude_kw=[]
    )
    # 排除词一票否决
    assert not matches(
        "cat politics debate", any_kw=["cat"], all_kw=[], exclude_kw=["politics"]
    )
    # 组合：any 命中 + all 满足 + 不含排除
    assert matches(
        "amazing cat meets dog today",
        any_kw=["amazing"], all_kw=["cat", "dog"], exclude_kw=["politics"],
    )


def test_matches_empty_any_means_no_constraint() -> None:
    """any 为空 = 不限关键词（只受 all/exclude 约束）。"""
    assert matches("anything at all", any_kw=[], all_kw=[], exclude_kw=[])
    assert not matches("anything", any_kw=[], all_kw=["required"], exclude_kw=[])


def test_matches_case_insensitive_and_selftext() -> None:
    assert matches("CUTE CAT!", any_kw=["cute cat"], all_kw=[], exclude_kw=[])
    text = "title only"
    assert not matches(text, any_kw=["hidden in body"], all_kw=[], exclude_kw=[])
    assert matches(text, any_kw=[], all_kw=[], exclude_kw=[],
                   extra_text="but hidden in body here")


# ---------- watch 通道 ----------


def test_watch_channels_disabled_returns_empty() -> None:
    class S:
        pipeline_watch_enabled = False
        pipeline_watch_subreddits = "aww, space"
        pipeline_watch_sort = "rising"

    assert watch_channels(S()) == []


def test_watch_channels_builds_sub_sort_pairs() -> None:
    class S:
        pipeline_watch_enabled = True
        pipeline_watch_subreddits = "aww, space"
        pipeline_watch_sort = "rising"

    assert watch_channels(S()) == ["aww:rising", "space:rising"]


# ---------- run_collect 词法预筛 ----------


class _FakePosts:
    """最小 collector 桩：返回固定 posts，不做网络。"""

    name = "reddit"

    def __init__(self, posts):
        self._posts = posts

    async def collect(self, ctx, channel, limit):
        return self._posts

# 满足 run_collect 的 SourceCollector isinstance 校验
from backend.pipeline.collectors.base import RawPost, SourceCollector  # noqa: E402


class _FakeCollector(SourceCollector):
    name = "reddit"

    def __init__(self, posts: list[RawPost]):
        self._posts = posts

    async def collect(self, ctx, channel, limit):
        return self._posts


def _raw(sid: str, title: str, score: int = 100) -> RawPost:
    return RawPost(
        source_id=sid, title=title,
        source_url=f"https://www.reddit.com/r/aww/comments/{sid}/x/",
        author="u", score=score, upvote_ratio=0.9, num_comments=1,
        created_utc=datetime.now(UTC).timestamp(), is_video=True,
    )


@pytest.mark.asyncio
async def test_run_collect_filter_fn_drops_non_matching(client) -> None:
    from sqlalchemy import select

    from backend.pipeline.base import StepContext
    from backend.pipeline.steps.collect import run_collect

    ctx = StepContext(run_id="t", settings=None, ai=None, emit=lambda e: None)
    posts = [
        _raw("hit-1", "a cute cat moment"),
        _raw("miss-1", "totally unrelated politics"),
    ]
    summary = await run_collect(
        ctx, "aww:rising", 10, _FakeCollector(posts),
        filter_fn=lambda p: matches(p.title, any_kw=["cat"], all_kw=[], exclude_kw=[]),
    )
    assert summary["collected"] == 2
    assert summary["filtered"] == 1
    assert summary["inserted"] == 1  # miss 被 filter_fn 丢弃
    async with session_factory() as session:
        titles = {t for (t,) in (await session.execute(select(Item.title))).all()}
    assert "a cute cat moment" in titles
    assert "totally unrelated politics" not in titles
