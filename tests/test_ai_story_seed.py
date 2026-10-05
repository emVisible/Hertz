"""ai-story 源第一次真跑时暴露的两件事（v0.34 D-224）。

起因：用户授权把 `ai-story/情感夜话` 接进 `pipeline_sources` 试跑。第一轮 65 秒后
`sources_err=1`、库里零条目，日志里两条独立缺陷：

① `ai-story generation failed: Invalid control character at: line 3 column 496`
   ——模型按 prompt 要求写了分段的故事，段落之间是**真换行**，而 JSON 字符串里
   不允许裸控制字符，`json.loads` 默认严格模式直接拒。也就是说"故事一旦分段就
   永远采不进来"，不是偶发。
② `failed to record collect failure for ai-story:ai-story/情感夜话`
   `TypeError: unsupported operand type(s) for +=: 'NoneType' and 'int'`
   ——collector 在建库行之前就抛错时，`SourceState` 新建行的 `fail_count` 还是
   Python 侧 default（要 flush 才落值），立刻 `+= 1` 就炸；异常又被外层吞掉，
   于是**每个新数据源的第一次失败都不会留下健康度记录**（冷却、连续失败、
   界面健康徽章全都没有）。reddit 那 40 个源因为行早就存在，从没露出这一面。
"""

import pytest
from sqlalchemy import delete, select

from backend.models.pipeline import SourceState
from backend.models.session import session_factory
from backend.pipeline.collectors.ai_story import _parse_story

# 这两条测试会在共享的 hertz_test 库里留下**非 reddit 源**的行，而
# `test_pipeline_engine.py::test_jobs_and_sources` 断言「/api/pipeline/sources
# 全是 reddit」——全局计数被别人家的行碰红过，所以自己的行自己扫干净。
_PROBE_CHANNELS = [("ai-story", "ai-story/记账测试"), ("rss", "rss/记账测试")]


@pytest.fixture(autouse=True)
async def _cleanup_probe_rows():
    yield
    async with session_factory() as session:
        for source, channel in _PROBE_CHANNELS:
            await session.execute(
                delete(SourceState).where(
                    SourceState.source == source, SourceState.channel == channel
                )
            )
        await session.commit()

# 模型真实返回的形状（本地 ollama batiai/gemma4-e4b:q4，2026-10-05 抓的），
# 关键在 story 值里有**裸换行**——分段的故事必然如此。
RAW_WITH_PARAGRAPHS = """```json
{
  "title": "深夜十点的秘密电波",
  "story": "白天，你得时刻保持清醒。
情绪，就像小小的电线，不许闪短路。

直到我遇到了她，一个总能在深夜给我发消息的朋友。"
}
```"""


def test_story_with_real_paragraph_breaks_parses_and_keeps_them() -> None:
    """分段故事（值里带裸换行）必须能解析，且段落不许被压成一行。"""
    title, story = _parse_story(RAW_WITH_PARAGRAPHS)
    assert title == "深夜十点的秘密电波"
    assert "\n\n" in story, "段落分隔被吃掉了"
    assert len(story) >= 50


def test_non_json_output_is_still_rejected() -> None:
    """正对照组：放宽的是控制字符，不是"随便什么都当故事收下"。

    这条在当前代码就是绿的——它挡的是我把 strict=False 修成"解析失败就兜底拼一段"
    那种更坏的走向。
    """
    with pytest.raises(RuntimeError):
        _parse_story("今天写不出故事，抱歉。")


def test_too_short_story_is_still_rejected() -> None:
    """正对照组二：过短的故事照旧不算产出（否则空壳条目会换一种来源重演）。"""
    with pytest.raises(RuntimeError):
        _parse_story('{"title": "短", "story": "只有两句。"}')


@pytest.mark.asyncio
async def test_first_failure_of_a_brand_new_source_is_recorded() -> None:
    """新源第一次采集失败必须留下健康度记账（fail_count / consecutive_fails / 错误）。

    这是 `ai-story/情感夜话` 的真实现场：collector 抛错时 SourceState 还没有行，
    旧代码在 `state.fail_count += 1` 上炸掉，异常被外层吞，于是界面上这个源
    "从没失败过"。
    """
    from backend.factory.registry import ServiceRegistry

    engine = ServiceRegistry.get().pipeline.engine
    channel = "ai-story/记账测试"
    await engine._record_collect_failure(
        "ai-story", channel, "AI 故事生成失败: 控制字符", ValueError("x")
    )

    async with session_factory() as session:
        state = (
            await session.execute(
                select(SourceState).where(
                    SourceState.source == "ai-story",
                    SourceState.channel == channel,
                )
            )
        ).scalar_one_or_none()
        assert state is not None, "新源的首次失败没落库（健康度记账被吞掉了）"
        assert state.fail_count == 1
        assert state.consecutive_fails == 1
        assert "控制字符" in (state.last_error or "")


@pytest.mark.asyncio
async def test_first_empty_response_of_a_brand_new_source_is_recorded() -> None:
    """同一形状的第三条腿：0 条记账路径也是"建行后立刻 +="，必须同样可靠。"""
    from backend.factory.registry import ServiceRegistry

    engine = ServiceRegistry.get().pipeline.engine
    channel = "rss/记账测试"
    await engine._record_collect_empty("rss", channel, {"skipped": 0})

    async with session_factory() as session:
        state = (
            await session.execute(
                select(SourceState).where(
                    SourceState.source == "rss",
                    SourceState.channel == channel,
                )
            )
        ).scalar_one_or_none()
        assert state is not None, "新源的首次空响应没落库"
        assert state.fail_count == 1
        assert state.consecutive_fails == 1
        assert "collected 0 items" in (state.last_error or "")
