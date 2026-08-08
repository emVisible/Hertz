"""v0.2.1 流水线治理单测：失败分类 / 评分成本闸门 / 排期引擎 / 自动过审 / phash / 导出包。

全部走 Fake LLM + 本地资源，不触碰真实网络。
"""

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import classify_error
from backend.pipeline.phash import compute_phash
from backend.pipeline.schedule import next_slot
from backend.pipeline.steps.score import ScoreStep

# ---------- 失败分类 ----------

def test_classify_error_categories() -> None:
    assert classify_error("download refused: unsafe media URL (x)") == "blocked"
    assert classify_error("HTTP 403 Forbidden") == "blocked"
    assert classify_error("429 Too Many Requests") == "rate_limit"
    assert classify_error("rate limit exceeded") == "rate_limit"
    assert classify_error("command timed out after 300s") == "timeout"
    assert classify_error("TTS provider not configured") == "tts"
    assert classify_error("edge-tts failed") == "tts"
    assert classify_error("ffmpeg failed (1): boom") == "ffmpeg"
    assert classify_error("LLM provider not configured — cannot score") == "llm"
    assert classify_error("publish failed: cookie missing") == "publish"
    assert classify_error("weird random error", step="download") == "download"
    assert classify_error("internal: crash") == "internal"
    assert classify_error("something unknown") == "other"


# ---------- 评分成本闸门 ----------

class _BudgetSettings:
    pipeline_score_max_per_run = 1
    pipeline_score_max_per_day = 100  # 日预算放大：隔离验证「单次运行」闸门
    pipeline_min_score = 6.0


class _Ai:
    llm_available = True

    async def score(self, **kwargs):
        class R:
            total = 7.5
            dimensions = {}
            reasons = []
            fallback = False
        return R()


@pytest.mark.asyncio
async def test_score_budget_exhausted_skips_item() -> None:
    """单次运行预算耗尽 → 第二条保持 downloaded 不评分（防 API 费用失控）。"""
    async with session_factory() as session:
        a = Item(status=ItemStatus.DOWNLOADED, source="reddit", source_id="budget-1",
                 title="t1", reddit_score=100, upvote_ratio=0.9)
        b = Item(status=ItemStatus.DOWNLOADED, source="reddit", source_id="budget-2",
                 title="t2", reddit_score=100, upvote_ratio=0.9)
        session.add_all([a, b])
        await session.commit()
        ids = [a.id, b.id]

    class Ctx:
        settings = _BudgetSettings()
        ai = _Ai()
        scores_used = 0

        def log(self, message, level="info"):
            pass

    step = ScoreStep()
    ctx = Ctx()  # 同一批次共享一个 ctx（运行内计数挂在 ctx 上）
    first = await step.process(ctx, await _load(ids[0]))
    assert first.status == "scored"
    # 预算耗尽：第二条跳过（保持 downloaded），不调用 LLM
    second = await step.process(ctx, await _load(ids[1]))
    assert second.status == "downloaded"


async def _load(item_id):
    async with session_factory() as session:
        return await session.get(Item, item_id)


# ---------- 本地排期引擎 ----------

def test_next_slot_respects_window_and_interval() -> None:
    now = datetime(2026, 8, 8, 9, 0, tzinfo=UTC)  # 周六 09:00，窗口 10:00-12:00
    slot = next_slot([], now=now, windows_raw="10:00-12:00,18:00-20:00",
                     min_interval_min=30, jitter_min=0)
    assert slot.hour == 10 and slot.minute == 0

    # 已有 10:00 排期 → 下一个槽位 10:30（最小间隔 30 分钟）
    existing = [datetime(2026, 8, 8, 10, 0, tzinfo=UTC)]
    slot2 = next_slot(existing, now=now, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot2.hour == 10 and slot2.minute == 30

    # 窗口内塞满（10:00/10:30/11:00/11:30）→ 跳到晚间窗口
    full = [
        datetime(2026, 8, 8, 10, 0, tzinfo=UTC),
        datetime(2026, 8, 8, 10, 30, tzinfo=UTC),
        datetime(2026, 8, 8, 11, 0, tzinfo=UTC),
        datetime(2026, 8, 8, 11, 30, tzinfo=UTC),
    ]
    slot3 = next_slot(full, now=now, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot3.hour == 18

    # 已过窗口 → 次日 10:00
    late = datetime(2026, 8, 8, 21, 0, tzinfo=UTC)
    slot4 = next_slot([], now=late, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot4.day == 9 and slot4.hour == 10


# ---------- 自动过审 ----------

@pytest.mark.asyncio
async def test_auto_approve_gated_by_config() -> None:
    async with session_factory() as session:
        old = Item(status=ItemStatus.QUEUED, source="reddit", source_id="aa-1",
                   title="old", updated_at=datetime.now(UTC) - timedelta(hours=24))
        session.add(old)
        await session.commit()
        item_id = old.id

    from backend.factory.registry import ServiceRegistry

    pipe = ServiceRegistry.get().pipeline
    # 默认关闭：不自动过审
    result = await pipe.auto_approve()
    assert result == {"enabled": False, "approved": 0}
    row = await _load(item_id)
    assert row.status == ItemStatus.QUEUED

    # 开启（阈值 1 小时）→ 超时条目自动 approve
    orig = pipe.engine.settings.pipeline_auto_approve
    orig_hours = pipe.engine.settings.pipeline_auto_approve_after_hours
    pipe.engine.settings.pipeline_auto_approve = True
    pipe.engine.settings.pipeline_auto_approve_after_hours = 1
    try:
        result = await pipe.auto_approve()
        assert result["approved"] == 1
        row = await _load(item_id)
        assert row.status == ItemStatus.APPROVED
    finally:
        pipe.engine.settings.pipeline_auto_approve = orig
        pipe.engine.settings.pipeline_auto_approve_after_hours = orig_hours


# ---------- phash（有 ffmpeg 才跑真实计算） ----------

@pytest.mark.asyncio
async def test_compute_phash_deterministic(tmp_path) -> None:
    from backend.library.thumbnails import find_ffmpeg

    if find_ffmpeg() is None:
        pytest.skip("ffmpeg unavailable")
    video = tmp_path / "sample.mp4"
    proc = await asyncio.create_subprocess_exec(
        str(find_ffmpeg()), "-v", "error", "-f", "lavfi",
        "-i", "color=c=red:s=64x64:d=1", "-pix_fmt", "yuv420p",
        "-y", str(video),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    assert video.exists()

    h1 = await compute_phash(str(video))
    h2 = await compute_phash(str(video))
    assert h1 is not None and h1 == h2
    assert len(h1) == 16
    assert await compute_phash(None) is None


# ---------- 导出包 ----------

@pytest.mark.asyncio
async def test_export_publisher_package(tmp_path) -> None:
    from backend.pipeline.publishers.router import PUBLISHERS, ExportPublisher

    video = tmp_path / "video.mp4"
    video.write_bytes(b"fake-video-bytes")
    srt = tmp_path / "subs.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:01,000\nhi\n", encoding="utf-8")

    class ItemStub:
        id = None
        video_path = str(video)
        subtitle_path = str(srt)
        cover_path = None
        source_url = "https://www.reddit.com/r/test/comments/1"
        author = "someone"
        score_total = 7.5
        scheduled_at = None
        title = "导出测试"
        script_json = {"bili_title": "导出测试", "bili_desc": "描述"}

    class SettingsStub:
        data_dir = tmp_path

    class Ctx:
        settings = SettingsStub()

        def log(self, message, level="info"):
            pass

    assert "export" in PUBLISHERS
    result = await ExportPublisher().publish(Ctx(), ItemStub())
    out = tmp_path / "exports"
    files = [p.name for p in out.rglob("*") if p.is_file()]
    assert "video.mp4" in files and "subs.srt" in files and "README.md" in files
    assert result["target"] == "export"
    assert "README.md" in result["files"]
