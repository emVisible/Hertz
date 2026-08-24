"""多源采集路由 + 新源 collector 单测（v0.22 非破坏性扩展）。

覆盖：
- 路由：裸名=Reddit 兼容 / 前缀解析 / 未知前缀报错
- ai-story：LLM JSON 解析、过短拒绝、per-tick 成本闸、RawPost 形状（text_only+selftext）
- rss：Atom/RSS2 双格式解析、HTML 剥离、短文跳过、配置缺失报错
"""

import json

import httpx
import pytest

from backend.pipeline.collectors.ai_story import AIStoryCollector, _parse_story
from backend.pipeline.collectors.base import RawPost
from backend.pipeline.collectors.router import resolve_collector, split_channel
from backend.pipeline.collectors.rss import RssFeedCollector, _parse_feed, parse_feeds_config


class _FakeReddit:
    name = "reddit"


# ---------- 路由 ----------


def test_split_channel_bare_name_is_reddit_compat() -> None:
    assert split_channel("Damnthatsinteresting") == ("reddit", "Damnthatsinteresting")
    assert split_channel("reddit/sub") == ("reddit", "sub")
    assert split_channel("ai-story/情感夜话") == ("ai-story", "情感夜话")
    assert split_channel("rss/tech") == ("rss", "tech")


def test_resolve_bare_and_prefixed() -> None:
    default = _FakeReddit()
    extra = {"rss": RssFeedCollector()}
    assert resolve_collector("any_sub", default, extra) is default
    assert resolve_collector("reddit/any_sub", default, extra) is default
    assert resolve_collector("rss/tech", default, extra) is extra["rss"]


def test_resolve_unknown_prefix_raises_without_touching_default() -> None:
    with pytest.raises(RuntimeError, match="未知采集源类型"):
        resolve_collector("unknown/x", _FakeReddit(), {})


# ---------- ai-story ----------


def test_parse_story_json_ok_and_short_rejected() -> None:
    title, story = _parse_story(json.dumps({"title": "雨夜的伞", "story": "那晚" + "很冷" * 40}))
    assert title == "雨夜的伞"
    assert len(story) >= 50
    with pytest.raises(RuntimeError, match="过短"):
        _parse_story(json.dumps({"title": "t", "story": "太短了"}))
    with pytest.raises(RuntimeError, match="非 JSON"):
        _parse_story("不是 json 的输出")


class _FakeAI:
    """chat_messages 返回预设 JSON；记录调用次数验证成本闸。"""

    def __init__(self, payload: str) -> None:
        self.payload = payload
        self.calls = 0
        self.llm_available = True

    async def chat_messages(self, messages, **kwargs):
        self.calls += 1
        return self.payload


class _Ctx:
    def __init__(self) -> None:
        self.settings = object()
        self.logs: list[str] = []

    def log(self, message: str, level: str = "info") -> None:
        self.logs.append(message)


@pytest.mark.asyncio
async def test_ai_story_collect_shape_and_cap(monkeypatch) -> None:
    from backend.config import settings as app_settings

    monkeypatch.setattr(app_settings, "pipeline_ai_story_per_tick", 2, raising=False)
    payload = json.dumps({"title": "深夜食堂的最后一碗汤", "story": "老板" * 300})
    coll = AIStoryCollector(ai=_FakeAI(payload))
    posts = await coll.collect(_Ctx(), "ai-story/情感夜话", limit=25)
    # 成本闸：limit=25 但 per_tick=2 → 只生成 2 条
    assert len(posts) == 2
    for p in posts:
        assert isinstance(p, RawPost)
        assert p.item_type == "text_only"
        assert p.selftext and p.title
        assert p.source_id


@pytest.mark.asyncio
async def test_ai_story_requires_llm() -> None:
    coll = AIStoryCollector(ai=None)
    with pytest.raises(RuntimeError, match="LLM"):
        await coll.collect(_Ctx(), "ai-story/x", limit=1)


# ---------- rss ----------

_ATOM_SAMPLE = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>第一篇：长文测试</title>
    <link href="https://example.com/a"/>
    <content>&lt;p&gt;{}&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>太短</title>
    <link href="https://example.com/b"/>
    <content>短</content>
  </entry>
</feed>
""".format("细节内容" * 30)

_RSS2_SAMPLE = """<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[第二篇：CDATA 标题]]></title>
    <link>https://example.com/c</link>
    <description>{}</description>
  </item>
</channel></rss>
""".format("叙述文字" * 40)


def test_rss_parse_atom_skips_short_entries() -> None:
    posts = _parse_feed(_ATOM_SAMPLE, "tech")
    assert len(posts) == 1
    assert posts[0].source_url == "https://example.com/a"
    assert posts[0].item_type == "text_only"
    assert "<p>" not in posts[0].selftext
    assert posts[0].source_id


def test_rss_parse_rss2_cdata() -> None:
    posts = _parse_feed(_RSS2_SAMPLE, "tech")
    assert len(posts) == 1
    assert posts[0].title.startswith("第二篇")


def test_feeds_config_parsing() -> None:
    feeds = parse_feeds_config("# 注释\n tech | https://a.com/f.xml \n坏行无分隔符\n")
    assert feeds == {"tech": "https://a.com/f.xml"}


@pytest.mark.asyncio
async def test_rss_unknown_feed_raises() -> None:
    coll = RssFeedCollector(client=httpx.AsyncClient())
    with pytest.raises(RuntimeError, match="未配置"):
        await coll.collect(_Ctx(), "rss/nope", limit=5)
