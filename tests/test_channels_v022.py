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

pytestmark = pytest.mark.ffmpeg

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


# ---------- v0.22 可见性补全：SSRF 防护 + /api/metrics ----------


def test_ssrf_block_private_and_allow_public(monkeypatch) -> None:
    import socket as _socket

    from backend.pipeline.collectors.rss import assert_public_http_url, is_blocked_host

    # 字面量 IP 不走 DNS，确定性
    assert is_blocked_host("127.0.0.1")
    assert is_blocked_host("192.168.1.10")
    assert is_blocked_host("10.0.0.2")
    assert is_blocked_host("169.254.169.254")
    assert not is_blocked_host("8.8.8.8")
    with pytest.raises(RuntimeError, match="仅支持"):
        assert_public_http_url("ftp://example.com/feed")
    with pytest.raises(RuntimeError, match="本机"):
        assert_public_http_url("http://localhost/feed.xml")
    with pytest.raises(RuntimeError, match="SSRF"):
        assert_public_http_url("http://169.254.169.254/latest/meta-data/")
    # example.com 需 DNS，离线环境下 mock 为公网 IP（93.184.216.34）
    _orig = _socket.getaddrinfo

    def _fake(host, *a, **kw):
        if host == "example.com":
            return [(_socket.AF_INET, _socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]
        return _orig(host, *a, **kw)

    monkeypatch.setattr(_socket, "getaddrinfo", _fake)
    assert_public_http_url("https://example.com/feed.xml")


@pytest.mark.asyncio
async def test_rss_collect_rejects_internal_feed() -> None:
    import httpx

    from backend.config import settings as app_settings
    from backend.pipeline.collectors.rss import RssFeedCollector

    class _Ctx:
        settings = object()

        def log(self, message: str, level: str = "info") -> None:
            pass

    app_settings.pipeline_rss_feeds = "intranet|http://127.0.0.1:9/feed.xml"
    coll = RssFeedCollector(client=httpx.AsyncClient())
    with pytest.raises(RuntimeError, match="SSRF"):
        await coll.collect(_Ctx(), "rss/intranet", limit=5)
    app_settings.pipeline_rss_feeds = ""


# ---------- 风格预设（v0.26）：命名创意包 CRUD + 套用仅动创意子集 ----------


@pytest.mark.asyncio
async def test_style_preset_crud_and_apply(_channel_cleanup) -> None:
    import uuid as _uuid

    from sqlalchemy import delete, select

    from backend.models.channel import Channel
    from backend.models.pipeline import StylePreset
    from backend.models.session import session_factory
    from backend.pipeline.style_presets import StylePresetService

    svc = StylePresetService()
    try:
        created = await svc.create(
            name="test-warm",
            config={
                "voice": "zh-CN-XiaoxiaoNeural",
                "bili_tid": 17,
                "title_style_prompt": "暖心标题",
                "tags": ["情感", "治愈"],
                "name": "HACK-should-be-dropped",
                "source_pool": ["x"],
            },
        )
        assert created["name"] == "test-warm"
        # 非 PRESET_KEYS 键被清洗
        assert "name" not in created["config"] and "source_pool" not in created["config"]
        assert created["config"]["voice"] == "zh-CN-XiaoxiaoNeural"

        listed = await svc.list_presets()
        assert any(p["id"] == created["id"] for p in listed)

        async with session_factory() as session:
            session.add(
                _make_channel(
                    "test-preset-target",
                    name="目标栏目",
                    source_pool=["rss/tech"],
                    voice="old-voice",
                )
            )
            await session.commit()

        applied = await svc.apply_to_channel(_uuid.UUID(created["id"]), "test-preset-target")
        assert applied["voice"] == "zh-CN-XiaoxiaoNeural"
        assert applied["bili_tid"] == 17
        assert applied["title_style_prompt"] == "暖心标题"
        # 归属类字段不动
        assert applied["name"] == "目标栏目"
        assert applied["public_id"] == "test-preset-target"
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(Channel).where(Channel.public_id == "test-preset-target")
                )
            ).scalar_one()
            assert row.source_pool == ["rss/tech"]
    finally:
        async with session_factory() as session:
            await session.execute(delete(Channel).where(Channel.public_id == "test-preset-target"))
            await session.execute(delete(StylePreset).where(StylePreset.name == "test-warm"))
            await session.commit()


@pytest.mark.asyncio
async def test_metrics_endpoint(client) -> None:
    """/api/metrics：版本/运行时长/tick 环形/备份状态。"""
    resp = await client.get("/api/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["version"]
    assert isinstance(body["uptime_s"], int)
    assert isinstance(body["ticks"], list)
    assert "backup" in body
