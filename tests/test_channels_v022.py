"""v0.22 栏目化扩展测试：绑定/人设注入/动态片头（非破坏性约束验证）。

非破坏性铁律的机器证明：无栏目 → 全部路径与 v0.21 等价；
有栏目 → 仅归属条目受影响。测试自建栏目数据并在 finally 清理
（共享 DB，防污染后续用例——D-181 惯例）。
"""

import json
import shutil
from types import SimpleNamespace

import pytest

from backend.models.session import session_factory


@pytest.fixture
async def _channel_cleanup():
    """清理本测试创建的 channels 行（按 key 前缀识别）。"""
    yield
    from sqlalchemy import delete

    from backend.models.channel import Channel

    async with session_factory() as session:
        await session.execute(delete(Channel).where(Channel.public_id.like("test-%")))
        await session.commit()


def _make_channel(public_id: str, **kwargs):
    from backend.models.channel import Channel

    defaults = {"public_id": public_id, "name": public_id, "enabled": True}
    defaults.update(kwargs)
    return Channel(**defaults)


# ---------- 绑定映射 ----------


@pytest.mark.asyncio
async def test_active_channel_bindings_and_none_default(_channel_cleanup) -> None:
    from backend.pipeline.helpers import active_channel_bindings

    # 无匹配栏目 → 空映射（v0.21 等价行为）
    assert await active_channel_bindings() == {}

    from sqlalchemy import select

    from backend.models.channel import Channel

    async with session_factory() as session:
        session.add(
            _make_channel(
                "test-c1",
                source_pool=["ai-story/情感夜话", "reddit/shortblessed"],
                enabled=True,
            )
        )
        session.add(
            _make_channel("test-c2", source_pool=["rss/tech"], enabled=False)
        )
        await session.commit()
        saved = (
            (await session.execute(select(Channel).where(Channel.public_id == "test-c1")))
            .scalar_one()
        )

    bindings = await active_channel_bindings()
    assert bindings.get("ai-story/情感夜话") == "test-c1"
    assert bindings.get("reddit/shortblessed") == "test-c1"
    # 未启用栏目不参与
    assert "rss/tech" not in bindings
    assert saved is not None


# ---------- ai-story 人设注入 ----------


@pytest.mark.asyncio
async def test_ai_story_persona_injection(_channel_cleanup) -> None:
    from sqlalchemy import select

    from backend.models.channel import Channel
    from backend.pipeline.collectors.ai_story import AIStoryCollector

    class _CaptureAI:
        llm_available = True

        def __init__(self) -> None:
            self.system_seen: str | None = None

        async def chat_messages(self, messages, **kwargs):
            self.system_seen = messages[0].content
            return json.dumps({"title": "巷口的灯", "story": "温情" * 200})

    async with session_factory() as session:
        session.add(
            _make_channel(
                "test-persona",
                source_pool=["ai-story/情感夜话"],
                persona_prompt="以「阿蓝」第一人称叙述，结尾必有一句夜色描写。",
            )
        )
        await session.commit()

    fake_ai = _CaptureAI()

    class _Ctx:
        settings = object()

        def log(self, message: str, level: str = "info") -> None:
            pass

    posts = await AIStoryCollector(ai=fake_ai).collect(_Ctx(), "ai-story/情感夜话", limit=1)
    assert len(posts) == 1 and posts[0].item_type == "text_only"
    assert "阿蓝" in (fake_ai.system_seen or "")
    # 清掉本测试产生的 discovered 条目（source_id 随机——按 source 删）
    async with session_factory() as session:
        rows = (
            await session.execute(select(Channel).where(Channel.public_id == "test-persona"))
        ).scalars().all()
        assert rows
    # （Item 由 collect 单测直接返回 RawPost 不入库，无需额外清理）


# ---------- 动态标题卡片头 ----------

ffmpeg_missing = shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None


@pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg/ffprobe 不可用")
@pytest.mark.asyncio
async def test_intro_prepend_extends_duration(tmp_path) -> None:
    """合成 1s 主片 + 栏目 2s 片头 → 成片时长 ≈3s；失败降级返回原片。"""
    import asyncio

    from backend.library.thumbnails import find_ffmpeg, find_ffprobe
    from backend.pipeline.producers.media import _prepend_channel_intro

    ffmpeg, ffprobe = find_ffmpeg(), find_ffprobe()
    main = tmp_path / "final.mp4"
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-y", "-f", "lavfi",
        "-i", "testsrc=size=320x240:rate=30:duration=1",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(main),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    assert main.exists()

    channel = SimpleNamespace(
        name="情感夜话",
        intro_config={"enabled": True, "duration_s": 2, "subtitle": "每晚一个真实的故事"},
    )
    out = await _prepend_channel_intro(channel, main)
    assert out == main, "成功时应原地替换"

    probe = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_entries", "format=duration", str(main),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out_json, _ = await probe.communicate()
    duration = float(json.loads(out_json.decode())["format"]["duration"])
    assert 2.8 <= duration <= 4.0, f"期望 ≈3s，实际 {duration}s"


@pytest.mark.skipif(ffmpeg_missing, reason="ffmpeg/ffprobe 不可用")
@pytest.mark.asyncio
async def test_intro_disabled_returns_original(tmp_path) -> None:
    """intro_config 未启用 → 原样返回（非破坏性）。"""
    from backend.pipeline.producers.media import _prepend_channel_intro

    main = tmp_path / "final.mp4"
    main.write_bytes(b"placeholder")
    channel = SimpleNamespace(name="x", intro_config={"enabled": False})
    assert await _prepend_channel_intro(channel, main) is not None
    assert main.read_bytes() == b"placeholder"
