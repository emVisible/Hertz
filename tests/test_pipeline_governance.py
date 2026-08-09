"""v0.2.1 流水线治理单测：失败分类 / 评分成本闸门 / 排期引擎 / 自动过审 / phash / 导出包。

全部走 Fake LLM + 本地资源，不触碰真实网络。
"""

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

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


# ---------- 新端点 HTTP 测试（§28 核心路径自动化验证） ----------

@pytest.mark.asyncio
async def test_failure_endpoints(client) -> None:
    """/failures 聚合 + /retry-class 批量重试 + 非法类 422（§8.1 输入校验）。"""
    async with session_factory() as session:
        session.add_all([
            Item(status=ItemStatus.FAILED, source="reddit", source_id="f-1",
                 title="t1", error="download failed: HTTP 403 Forbidden",
                 error_class="blocked", video_path=None),
            Item(status=ItemStatus.FAILED, source="reddit", source_id="f-2",
                 title="t2", error="LLM provider not configured",
                 error_class="llm", video_path=None),
        ])
        await session.commit()

    failures = (await client.get("/api/pipeline/failures")).json()
    assert failures.get("blocked") == 1
    assert failures.get("llm") == 1

    resp = await client.post("/api/pipeline/retry-class", json={"cls": "blocked"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["requeued"] == 1
    async with session_factory() as session:
        rows = (await session.execute(
            select(Item).where(Item.source_id.in_(["f-1", "f-2"]))
        )).scalars().all()
        by_id = {r.source_id: r for r in rows}
    assert by_id["f-1"].status == "discovered"  # 无成片 → 回到 discovered
    assert by_id["f-1"].error is None and by_id["f-1"].error_class == ""
    assert by_id["f-2"].status == "failed"  # 其他类不受影响

    bad = await client.post("/api/pipeline/retry-class", json={"cls": "nope"})
    assert bad.status_code == 422


@pytest.mark.asyncio
async def test_schedule_next_endpoint(client) -> None:
    """/schedule/next 返回下一个发布槽位（本地排期引擎）。"""
    resp = await client.get("/api/pipeline/schedule/next")
    assert resp.status_code == 200, resp.text
    slot = resp.json()["recommended_at"]
    parsed = datetime.fromisoformat(slot)
    assert parsed.tzinfo is not None


@pytest.mark.asyncio
async def test_supply_warnings_endpoint(client) -> None:
    """/supply 供给告警：清空后 → funnel_empty。"""
    async with session_factory() as session:
        rows = (await session.execute(select(Item))).scalars().all()
        for r in rows:
            await session.delete(r)
        await session.commit()
    resp = await client.get("/api/pipeline/supply")
    assert resp.status_code == 200, resp.text
    assert "funnel_empty" in resp.json()["warnings"]


@pytest.mark.asyncio
async def test_auto_approve_endpoint(client) -> None:
    """/auto-approve 手动触发：配置关闭时幂等 no-op。"""
    resp = await client.post("/api/pipeline/auto-approve")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"enabled": False, "approved": 0}


# ---------- 内容日历（v0.2.3） ----------

@pytest.mark.asyncio
async def test_calendar_endpoint(client) -> None:
    """/pipeline/calendar：区间内排期/已发布 + 未排期待办，跨月范围过滤。"""
    from datetime import UTC, datetime

    async with session_factory() as session:
        in_month = Item(
            status=ItemStatus.APPROVED, source="reddit", source_id="cal-1",
            title="排期中", scheduled_at=datetime(2026, 8, 10, 10, 0, tzinfo=UTC),
        )
        published = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="cal-2",
            title="已发布", published_at=datetime(2026, 8, 5, 18, 30, tzinfo=UTC),
        )
        outside = Item(
            status=ItemStatus.APPROVED, source="reddit", source_id="cal-3",
            title="下月排期", scheduled_at=datetime(2026, 9, 1, 10, 0, tzinfo=UTC),
        )
        unscheduled = Item(
            status=ItemStatus.QUEUED, source="reddit", source_id="cal-4", title="待排期"
        )
        session.add_all([in_month, published, outside, unscheduled])
        await session.commit()

    resp = await client.get(
        "/api/pipeline/calendar", params={"from": "2026-08-01", "to": "2026-08-31"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    keys = {i["source_id"] for i in body["items"]}
    assert keys == {"cal-1", "cal-2"}  # 下月排期被过滤
    assert {i["source_id"] for i in body["unscheduled"]} == {"cal-4"}

    # 缺省参数：缺省 to → 从 from 起的当月
    resp2 = await client.get("/api/pipeline/calendar", params={"from": "2026-08-01"})
    assert resp2.status_code == 200
    keys2 = {i["source_id"] for i in resp2.json()["items"]}
    assert keys2 == {"cal-1", "cal-2"}


# ---------- 素材 AI 整理 / 查重 / 重命名（v0.2.3 Wave A3） ----------

def _read_text(p: str) -> str:
    """测试辅助：读文件文本（同步，供 to_thread 用）。"""
    return Path(p).read_text(encoding="utf-8")


def _exists(p: str) -> bool:
    """测试辅助：文件存在性（同步，供 to_thread 用）。"""
    return Path(p).exists()


class _OrganizeLLM:
    """组织接口 fake：返回固定 JSON 建议。"""

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        payload = (
            '{"items":[{"path":"/tmp/org/a.mp4","tags":["测试","风景"],'
            '"suggested_name":"b.mp4"}]}'
        )
        for ch in payload:
            yield ch

    async def aclose(self) -> None:
        pass


@pytest.mark.asyncio
async def test_ai_organize_and_rename(client, tmp_path, monkeypatch) -> None:
    """AI 整理：建议生成（fake LLM）→ 确认后打标/重命名（sidecar 同步迁移）。"""
    from backend.ai.router import AIRouter

    # 素材根指向临时目录（_allowed_roots 读 assets_root）
    from backend.config import runtime_config
    from backend.factory.registry import ServiceRegistry

    real_load = runtime_config.load

    def fake_load():
        data = dict(real_load())
        data["assets_root"] = str(tmp_path)
        return data

    monkeypatch.setattr(runtime_config, "load", fake_load)

    video = tmp_path / "a.mp4"
    video.write_bytes(b"fake-video")
    # 带标签 sidecar（验证重命名迁移）
    from backend.library.browser import write_tags

    write_tags(video, ["旧标签"])

    registry = ServiceRegistry.get()
    original_ai = registry.ai
    registry.ai = AIRouter(llm=_OrganizeLLM(), image=None, tts=None)
    try:
        resp = await client.post("/api/library/ai-organize", json={"paths": [str(video)]})
        assert resp.status_code == 200, resp.text
        results = resp.json()["results"]
        assert len(results) == 1
        assert results[0]["tags"] == ["测试", "风景"]
        assert results[0]["suggested_name"] == "b.mp4"

        # 确认后应用：打标（tags sidecar 合并）
        resp = await client.post(
            "/api/library/tags", json={"path": str(video), "tags": results[0]["tags"]}
        )
        assert resp.status_code == 200, resp.text

        # 确认后应用：重命名（sidecar 同步迁移）
        resp = await client.post(
            "/api/library/rename", json={"path": str(video), "new_name": "b.mp4"}
        )
        assert resp.status_code == 200, resp.text
        renamed = tmp_path / "b.mp4"
        assert renamed.exists() and not video.exists()
        assert await asyncio.to_thread(_exists, f"{renamed}.meta.json")  # 标签 sidecar 随行
        meta_text = await asyncio.to_thread(_read_text, f"{renamed}.meta.json")
        assert "测试" in meta_text

        # 越界重命名（含路径分隔符）→ 422
        resp = await client.post(
            "/api/library/rename", json={"path": str(renamed), "new_name": "../evil.mp4"}
        )
        assert resp.status_code == 422

        # 批上限 → 422
        many = [str(video)] * 21
        resp = await client.post("/api/library/ai-organize", json={"paths": many})
        assert resp.status_code == 422
    finally:
        registry.ai = original_ai


@pytest.mark.asyncio
async def test_duplicates_endpoint(tmp_path, monkeypatch) -> None:
    """查重：同内容视频聚为一组，不同内容不误报。"""
    from backend.library.thumbnails import find_ffmpeg

    if find_ffmpeg() is None:
        pytest.skip("ffmpeg unavailable")
    import subprocess

    ffmpeg = str(find_ffmpeg())

    # 注：纯色视频的 phash 退化（全 0/全 1）——用有纹理的测试源区分内容
    def make(path, source):
        subprocess.run(
            [ffmpeg, "-v", "error", "-f", "lavfi", "-i", source,
             "-pix_fmt", "yuv420p", "-y", str(path)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    a = tmp_path / "a.mp4"
    b = tmp_path / "b.mp4"
    c = tmp_path / "c.mp4"
    make(a, "testsrc=duration=1:size=64x64:rate=10")
    make(b, "testsrc=duration=1:size=64x64:rate=10")  # 与 a 相同 → 重复组
    make(c, "smptebars=duration=1:size=64x64:rate=10")  # 不同 → 独立

    from backend.routers import library as lib

    async def fake_roots():
        return [tmp_path]

    monkeypatch.setattr(lib, "_allowed_roots", fake_roots)
    resp = await lib.find_duplicates(str(tmp_path), limit=120)
    assert resp["scanned"] == 3
    groups = resp["groups"]
    assert len(groups) == 1  # 只有 red 组
    assert {f["name"] for f in groups[0]["files"]} == {"a.mp4", "b.mp4"}


# ---------- 封面上传（v0.2.6） ----------

@pytest.mark.asyncio
async def test_upload_cover_endpoint(client, tmp_path, monkeypatch) -> None:
    """POST /items/{id}/cover：multipart 上传 → data/media/covers/ 落盘 + cover_path 更新。"""
    from backend.factory.registry import ServiceRegistry
    from backend.models.item import Item

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.QUEUED, source="reddit",
            source_id="cover-1", title="封面测试",
        )
        session.add(item)
        await session.commit()
        item_id = item.id

    files = ServiceRegistry.get().files
    original = files.data_dir
    monkeypatch.setattr(files, "data_dir", tmp_path)  # 封面落盘到临时数据根
    try:
        resp = await client.post(
            f"/api/pipeline/items/{item_id}/cover",
            files={"file": ("cover.png", b"\x89PNG\r\n\x1a\nfake-image", "image/png")},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert tmp_path in Path(body["cover_path"]).parents
        assert await asyncio.to_thread(_exists, body["cover_path"])
        # 非法扩展名 → 422
        bad = await client.post(
            f"/api/pipeline/items/{item_id}/cover",
            files={"file": ("x.txt", b"not-an-image", "text/plain")},
        )
        assert bad.status_code == 422
    finally:
        monkeypatch.setattr(files, "data_dir", original)


# ---------- 分区自动分配（v0.2.6，参考原项目 assign_bili_tid） ----------

def test_assign_bili_tid_resolution() -> None:
    from backend.pipeline.category import assign_bili_tid

    # 精确 subreddit
    assert assign_bili_tid("aww") == 152
    assert assign_bili_tid("funny") == 138
    assert assign_bili_tid("space") == 85
    # 关键词兜底（大小写不敏感）
    assert assign_bili_tid("CrazyAnimals") == 152
    assert assign_bili_tid("cooking_master") == 23
    # 类型默认：图 202 / 视频 21
    assert assign_bili_tid("random_sub") == 21
    assert assign_bili_tid("random_sub", "image_gallery") == 202


# ---------- 重新处理 / 重新翻译 / 过期重排（v0.2.7） ----------

@pytest.mark.asyncio
async def test_reprocess_and_retranslate(client) -> None:
    """reprocess 清脚本全重跑；retranslate 保留脚本只重翻译。"""

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.QUEUED, source="reddit", source_id="rp-1", title="重处理",
            script_json={"script": "旧脚本", "bili_tid": 201},
            video_path="/x/v.mp4", cover_path="/x/c.jpg", audio_path="/x/a.mp3",
            phash="abc",
        )
        session.add(item)
        await session.commit()
        item_id = item.id

    resp = await client.post(
        f"/api/pipeline/items/{item_id}/reprocess", params={"retranslate": 1}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "scored" and body["retranslate"] is True
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "scored"
        assert row.script_json is not None  # 保留脚本
        assert row.video_path is None and row.cover_path is None  # 产物清空

    # 回到 queued 后重新处理（完整重跑）
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        row.status = ItemStatus.QUEUED
        await session.commit()
    resp = await client.post(f"/api/pipeline/items/{item_id}/reprocess")
    assert resp.status_code == 200, resp.text
    assert resp.json()["retranslate"] is False
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "scored"
        assert row.script_json is None  # 脚本重生成

    # 非法状态（published）→ 409
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        row.status = ItemStatus.PUBLISHED
        await session.commit()
    resp = await client.post(f"/api/pipeline/items/{item_id}/reprocess")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_reschedule_expired(client) -> None:
    """过期排期自动更新为未来推荐槽位；未过期不动。"""
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    async with session_factory() as session:
        expired = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-1",
                       title="过期", scheduled_at=now - timedelta(days=2))
        fresh = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-2",
                     title="未过期", scheduled_at=now + timedelta(days=1))
        session.add_all([expired, fresh])
        await session.commit()
        expired_id, fresh_id = expired.id, fresh.id

    resp = await client.post("/api/pipeline/reschedule-expired")
    assert resp.status_code == 200, resp.text
    assert resp.json()["updated"] >= 1
    async with session_factory() as session:
        expired = await session.get(Item, expired_id)
        fresh = await session.get(Item, fresh_id)
        assert expired.scheduled_at is not None and expired.scheduled_at > now
        assert fresh.scheduled_at == now + timedelta(days=1)  # 未过期不动


def test_auto_tid_in_serialize(client) -> None:
    """serialize 未手动设置 tid 时附 auto_tid 建议。"""
    from backend.pipeline.service import _auto_tid

    class Stub:
        subreddit = "aww"
        item_type = "video_raw"

    assert _auto_tid(Stub()) == 152  # 动物


# ---------- 处理语言本地化（v0.2.7，参考原项目 locales） ----------

class _TranslateLLM:
    """翻译接口 fake：固定返回英文译文。"""

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        for ch in "This is the translated English narration text for testing purposes.":
            yield ch

    async def aclose(self) -> None:
        pass


@pytest.mark.asyncio
async def test_localize_text_falls_back_on_failure() -> None:
    """翻译失败回退原文（不阻塞生产）；成功时返回译文。"""
    from backend.ai.router import AIRouter
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.producers.media import _localize_text

    registry = ServiceRegistry.get()
    original = registry.ai
    try:
        registry.ai = AIRouter(llm=_TranslateLLM(), image=None, tts=None)
        translated = await _localize_text(registry.ai, "这是中文旁白", "en-US")
        assert "translated" in translated
    finally:
        registry.ai = original


@pytest.mark.asyncio
async def test_reschedule_assigns_unscheduled(client) -> None:
    """未排期条目自动分配推荐槽位（每次进入系统都有排期）。"""
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    async with session_factory() as session:
        a = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-3", title="未排期A")
        b = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-4", title="未排期B")
        session.add_all([a, b])
        await session.commit()
        ids = [a.id, b.id]

    resp = await client.post("/api/pipeline/reschedule-expired")
    assert resp.status_code == 200, resp.text
    async with session_factory() as session:
        rows = [await session.get(Item, i) for i in ids]
        assert all(r.scheduled_at is not None and r.scheduled_at > now for r in rows)
        # 分配槽位互不冲突（最小间隔）
        slots = sorted(r.scheduled_at for r in rows)
        assert (slots[1] - slots[0]).total_seconds() >= 30 * 60 - 60


# ---------- 采集 0 条不静默完成（v0.2.8，参考原项目 failed_subs/供给告警） ----------

@pytest.mark.asyncio
async def test_collect_zero_items_marks_empty_and_cooldown() -> None:
    """接口正常但返回 0 条：summary.empty=True + 健康度失败记录 + 冷却。"""
    from backend.factory.registry import ServiceRegistry
    from backend.models.pipeline import SourceState
    from backend.pipeline.collectors.base import RawPost
    from backend.pipeline.collectors.reddit import FakeRedditCollector

    registry = ServiceRegistry.get()
    original = registry.pipeline.engine.collector
    try:
        registry.pipeline.engine.collector = FakeRedditCollector([])  # 0 条
        engine = registry.pipeline.engine

        class Ctx:
            run_id = "zero-test"

            def log(self, message, level="info"):
                pass

        summary = await engine._run_step(Ctx(), "collect", limit=5, channel="test:hot")
        assert summary.get("collected", 0) == 0
        assert summary.get("empty") is True

        # 健康度：失败计数 + 冷却
        async with session_factory() as session:
            state = (
                await session.execute(
                    select(SourceState).where(
                        SourceState.source == "reddit",
                        SourceState.channel == "test:hot",
                    )
                )
            ).scalar_one_or_none()
            assert state is not None
            assert state.fail_count >= 1 and state.consecutive_fails >= 1
            assert "collected 0 items" in (state.last_error or "")

        # 冷却生效：同 channel 再次运行 → 跳过
        summary2 = await engine._run_step(Ctx(), "collect", limit=5, channel="test:hot")
        assert summary2.get("cooldown_s", 0) > 0

        # 恢复有数据 → 清除冷却
        registry.pipeline.engine.collector = FakeRedditCollector([RawPost(
            source_id="z-1", title="新帖", source_url="https://x/1",
            media_url="https://x/1.mp4", author="a", score=1,
            upvote_ratio=1.0, num_comments=0, created_utc=1.0,
            is_video=True, item_type="video_raw",
        )])
        # 恢复有数据 → 新 channel 正常采集（成功路径；test:hot 仍在冷却中）
        registry.pipeline.engine.collector = FakeRedditCollector([])  # 复原空收集器占位
        summary3 = await engine._run_step(Ctx(), "collect", limit=5, channel="test:ok")
        assert summary3.get("collected") == 0
        assert summary3.get("empty") is True
        async with session_factory() as session:
            state = (
                await session.execute(
                    select(SourceState).where(
                        SourceState.source == "reddit",
                        SourceState.channel == "test:ok",
                    )
                )
            ).scalar_one_or_none()
            assert state is not None
            assert state.consecutive_fails >= 1  # 空源同样记账
    finally:
        registry.pipeline.engine.collector = original
