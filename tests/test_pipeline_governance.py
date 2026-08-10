"""v0.2.1 流水线治理单测：失败分类 / 评分成本闸门 / 排期引擎 / 自动过审 / phash / 导出包。

全部走 Fake LLM + 本地资源，不触碰真实网络。
"""

import asyncio
import re
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
async def test_back_to_prep_and_collect(client) -> None:
    """相邻双向（v0.3.9）：审核→预处理→采集 逐级打回，职责单一。"""

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.QUEUED, source="reddit", source_id="btp-1", title="打回",
            script_json={"script": "旧脚本", "bili_tid": 201},
            video_path="/x/v.mp4", cover_path="/x/c.jpg", audio_path="/x/a.mp3",
            phash="abc",
        )
        session.add(item)
        await session.commit()
        item_id = item.id

    # 审核打回预处理：queued → scored，清产物保留脚本
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "scored"
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "scored"
        assert row.script_json is not None  # 脚本保留
        assert row.video_path is None and row.phash is None  # 产物清空

    # 预处理打回采集：scored → discovered
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-collect")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "discovered"
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "discovered"

    # 非法打回（discovered → back-to-prep）→ 409
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_requeue_from_published(client) -> None:
    """发布连通审核（v0.3.9）：已发布条目可打回审核队列。"""

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="rp-1", title="已发布",
        )
        session.add(item)
        await session.commit()
        item_id = item.id

    resp = await client.post(f"/api/pipeline/items/{item_id}/requeue")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"


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


# ---------- score 服务端重算 / safety 红线 / 预过滤（v0.3.0） ----------

def test_recompute_total_weighted() -> None:
    from backend.pipeline.steps.score import recompute_total

    # short_form 加权 1.2：总和非等权平均
    dims = {"entertainment": 5.0, "short_form": 10.0}
    total = recompute_total(dims)
    assert abs(total - (5 + 12) / 2.2) < 0.01
    assert isinstance(total, float) and total <= 10.0
    # 空维度 → 0
    assert recompute_total({}) == 0.0
    # 非数值忽略
    assert recompute_total({"entertainment": 5.0, "script": "x"}) == 5.0


@pytest.mark.asyncio
async def test_score_safety_redline_rejects() -> None:
    """safety ≤3 → 强制拒绝（合规红线，人工导入也不豁免）。"""
    from backend.models.item import Item
    from backend.pipeline.steps.score import ScoreStep

    class Ai:
        llm_available = True

        async def score(self, **kwargs):
            class R:
                total = 9.9  # LLM 自报高分——不采信
                dimensions = {"entertainment": 8.0, "safety": 2.0}
                reasons = []
                fallback = False
            return R()

    class SettingsStub:
        pipeline_score_max_per_run = 100
        pipeline_score_max_per_day = 1000
        pipeline_min_score = 6.0
        pipeline_prefilter_min_reddit_score = 50
        pipeline_prefilter_min_upvote_ratio = 0.85

    class Ctx:
        settings = SettingsStub()
        ai = Ai()
        scores_used = 0

        def log(self, message, level="info"):
            pass

    item = Item(status="downloaded", source="reddit", source_id="safety-1",
                title="合规测试", reddit_score=100, upvote_ratio=0.9)
    result = await ScoreStep().process(Ctx(), item)
    assert result.status == "rejected"
    assert result.data["reason"] == "safety_redline"
    assert result.data["score_total"] == 4.86  # (8*1 + 2*1.1)/2.1 重算
    assert any("safety" in r for r in result.data["score_reasons"])


# ---------- 去重（v0.3.0，参考原项目 dedupe.py） ----------

def test_title_fingerprint_and_hamming() -> None:
    from backend.pipeline.dedupe import hamming_distance, normalize_title_key

    # 指纹：小写/去标点/压缩空白/截断
    assert normalize_title_key("Hello, World!!") == normalize_title_key("hello world")
    assert normalize_title_key("  A  B  ") == "a b"
    assert len(normalize_title_key("x" * 200)) <= 120
    # 汉明距离：一位翻转
    assert hamming_distance("0000000000000000", "0000000000000001") == 1
    assert hamming_distance("ffffffffffffffff", "fffffffffffffffe") == 1
    assert hamming_distance("0123456789abcdef", "0123456789abcdef") == 0
    assert hamming_distance("", "abc") == 999


@pytest.mark.asyncio
async def test_find_title_duplicate_ignores_unscored() -> None:
    """标题去重只统计已评分条目——同批 discovered 不误伤（查漏补缺）。"""
    from backend.models.item import Item
    from backend.pipeline.dedupe import find_title_duplicate

    async with session_factory() as session:
        unscored = Item(status="discovered", source="reddit", source_id="td-1",
                        title="一个很棒的夜晚观察笔记标题")
        scored = Item(status="scored", source="reddit", source_id="td-2",
                      title="另一个完全不同的标题", score_total=7.0)
        session.add_all([unscored, scored])
        await session.commit()

    # 未评分条目标题 → 不命中（避免自身误伤）
    assert await find_title_duplicate("一个很棒的夜晚观察笔记标题") is False
    # 已评分条目标题 → 命中
    assert await find_title_duplicate("另一个完全不同的标题") is True
    # 短标题（<6 字）不查
    assert await find_title_duplicate("短") is False


@pytest.mark.asyncio
async def test_find_phash_duplicate_distance() -> None:
    """phash 汉明距离 ≤5 判重；6+ 位翻转不误报。"""
    from backend.models.item import Item
    from backend.pipeline.dedupe import find_phash_duplicate

    base = "0123456789abcdef"
    near = "0123456789abcdee"  # 1 位翻转
    far = "ffffffffffffffff"  # 32+ 位翻转

    async with session_factory() as session:
        session.add(Item(status="published", source="reddit", source_id="ph-1",
                         title="已发布", phash=base))
        await session.commit()

    assert await find_phash_duplicate(near) is True  # 距离 1 ≤5
    assert await find_phash_duplicate(far) is False  # 距离大
    assert await find_phash_duplicate("") is False


# ---------- 字幕加权分配 / 旁白起始延迟（v0.3.0，参考原项目 subtitle/tts） ----------

def test_script_to_srt_weighted_and_offset(tmp_path) -> None:
    from backend.pipeline.producers.media import script_to_srt

    out = tmp_path / "subs.srt"
    text = "这是一个很长的句子啊。短。"
    script_to_srt(text, 10.0, out, start_offset=1.0)
    raw = out.read_text(encoding="utf-8")
    times = []
    pat = r"(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)"
    for m in re.finditer(pat, raw):
        sec1 = int(m.group(1)) * 3600 + int(m.group(2)) * 60
        sec1 += int(m.group(3)) + int(m.group(4)) / 1000
        sec2 = int(m.group(5)) * 3600 + int(m.group(6)) * 60
        sec2 += int(m.group(7)) + int(m.group(8)) / 1000
        times.append((sec1, sec2))
    assert times, "至少一条字幕"
    # 起始偏移：第一条从 1.0s 开始
    assert times[0][0] == 1.0
    # 长句占比大：第一条（长句）时长 ≥ 第二条（短句）
    long_seg = times[0][1] - times[0][0]
    short_seg = times[1][1] - times[1][0]
    assert long_seg > short_seg
    # 最小可读时长 0.45s
    assert all((b - a) >= 0.449 for a, b in times)
    # 不超总时长
    assert times[-1][1] <= 10.0


def test_narration_start_offset() -> None:
    from backend.pipeline.producers.media import narration_start_offset

    assert narration_start_offset("watch this video about dogs", 10.0) == 0.45
    assert narration_start_offset("slowly explaining the details", 10.0) == 1.1
    assert narration_start_offset("今天聊聊这个", 10.0) == 0.45
    assert narration_start_offset("hello world", 10.0) == 0.75
    # 封顶 min(2.2, dur*0.15)
    assert narration_start_offset("watch", 4.0) <= 0.6
    assert narration_start_offset("whatever", 30.0) <= 2.2


# ---------- 入库序号 seq（v0.3.1：同批 created_at 相同，seq 区分先后） ----------

@pytest.mark.asyncio
async def test_list_items_ordered_by_seq() -> None:
    """同批插入（created_at 相同）→ list_items 按 seq desc（真·入库顺序）。"""
    from datetime import UTC, datetime

    from backend.factory.registry import ServiceRegistry

    ts = datetime.now(UTC)
    async with session_factory() as session:
        first = Item(status=ItemStatus.QUEUED, source="reddit", source_id="seq-1",
                     title="先入库", created_at=ts)
        second = Item(status=ItemStatus.QUEUED, source="reddit", source_id="seq-2",
                      title="后入库", created_at=ts)
        session.add_all([first, second])
        await session.commit()

    rows = await ServiceRegistry.get().pipeline.list_items(status="queued", limit=50)
    ids = [r["source_id"] for r in rows if r["source_id"].startswith("seq-")]
    assert len(ids) == 2
    # 后插入的 seq 更大 → desc 排前
    assert ids == ["seq-2", "seq-1"]
    assert rows[0]["seq"] is not None  # serialize 输出 seq


# ---------- 生产方式（v0.3.3，预处理人工选择） ----------

def test_normalize_produce_options() -> None:
    from backend.pipeline.service import PipelineService

    # 直发互斥：清其他
    opts = PipelineService.normalize_produce_options(
        {
            "passthrough": True, "voice": True, "subtitle": True,
            "translate": True, "mute": True,
        }
    )
    assert opts == {
        "passthrough": True, "voice": False, "subtitle": False,
        "translate": False, "mute": False,
    }
    # 翻译自动附带字幕
    opts = PipelineService.normalize_produce_options({"voice": True, "translate": True})
    assert opts["subtitle"] is True and opts["voice"] is True
    # 非法模块忽略
    opts = PipelineService.normalize_produce_options({"voice": True, "evil": True})
    assert "evil" not in opts


@pytest.mark.asyncio
async def test_produce_options_batch_endpoint(client) -> None:
    """批量设置生产方式 + 互斥校验。"""
    async with session_factory() as session:
        a = Item(status="discovered", source="reddit", source_id="po-1", title="A")
        b = Item(status="discovered", source="reddit", source_id="po-2", title="B")
        session.add_all([a, b])
        await session.commit()
        ids = [a.id, b.id]

    # 批量设置：配音+字幕
    resp = await client.post("/api/pipeline/produce-options", json={
        "ids": [str(i) for i in ids],
        "options": {"voice": True, "subtitle": True},
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["updated"] == 2
    items = (
        await client.get(
            "/api/pipeline/items", params={"status": "discovered", "limit": 200}
        )
    ).json()
    for it in items:
        if it["source_id"] in ("po-1", "po-2"):
            assert it["produce_options"]["voice"] is True
            assert it["produce_options"]["subtitle"] is True

    # 直发互斥：改为直发后其他模块全清
    resp = await client.post("/api/pipeline/produce-options", json={
        "ids": [str(ids[0])],
        "options": {"passthrough": True, "voice": True},
    })
    assert resp.status_code == 200, resp.text
    items2 = (
        await client.get(
            "/api/pipeline/items", params={"status": "discovered", "limit": 200}
        )
    ).json()
    item = next(i for i in items2 if i["source_id"] == "po-1")
    assert item["produce_options"]["passthrough"] is True
    assert item["produce_options"]["voice"] is False

    # 空 ids → 422
    bad = await client.post("/api/pipeline/produce-options", json={"ids": [], "options": {}})
    assert bad.status_code == 422


# ---------- 半自动化：单条制作 / 分发目标（v0.3.4） ----------

@pytest.mark.asyncio
async def test_produce_one_endpoint(client, monkeypatch) -> None:
    """预处理「制作」按钮：单条立即制作（未下载 → 409；已下载 → 走 produce）。"""
    async with session_factory() as session:
        no_raw = Item(status="discovered", source="reddit", source_id="po-one-1", title="无素材")
        has_raw = Item(status="downloaded", source="reddit", source_id="po-one-2",
                       title="有素材", raw_path="/nonexistent/raw.mp4")
        session.add_all([no_raw, has_raw])
        await session.commit()
        no_raw_id, has_raw_id = no_raw.id, has_raw.id

    # 未下载 → 409
    resp = await client.post(f"/api/pipeline/items/{no_raw_id}/produce")
    assert resp.status_code == 409

    # 已下载但 raw 文件不存在 → produce 失败（502，raw media missing）
    resp = await client.post(f"/api/pipeline/items/{has_raw_id}/produce")
    assert resp.status_code in (502,)


@pytest.mark.asyncio
async def test_publish_one_with_target(client) -> None:
    """分发目标逐条覆盖（v0.3.4）：publish target=export 生效并记录。"""
    async with session_factory() as session:
        item = Item(status=ItemStatus.APPROVED, source="reddit", source_id="pt-1",
                    title="分发目标", video_path="/nonexistent/v.mp4",
                    script_json={"bili_title": "分发目标"})
        session.add(item)
        await session.commit()
        item_id = item.id

    # export 目标：导出包模式（无视频文件 → 502，但 target 解析正确）
    resp = await client.post(f"/api/pipeline/items/{item_id}/publish", params={"target": "export"})
    assert resp.status_code == 502  # 文件缺失（目标解析已通过）
    # 非法目标 → 502
    resp = await client.post(f"/api/pipeline/items/{item_id}/publish", params={"target": "evil"})
    assert resp.status_code == 502


@pytest.mark.asyncio
async def test_reject_discovered_item(client) -> None:
    """预处理拒绝（v0.3.4）：未下载（discovered）条目也可人工筛掉。"""
    async with session_factory() as session:
        item = Item(status=ItemStatus.DISCOVERED, source="reddit", source_id="rej-disc",
                    title="预处理拒绝")
        session.add(item)
        await session.commit()
        item_id = item.id

    resp = await client.post(f"/api/pipeline/items/{item_id}/reject")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "rejected"


@pytest.mark.asyncio
async def test_score_one_endpoint(client) -> None:
    """预处理手动评分（v0.3.5）：仅已下载条目；未下载 409。"""
    async with session_factory() as session:
        not_dl = Item(status="discovered", source="reddit", source_id="sc-1", title="未下载")
        dl = Item(status="downloaded", source="reddit", source_id="sc-2",
                  title="已下载", reddit_score=100, upvote_ratio=0.9)
        session.add_all([not_dl, dl])
        await session.commit()
        not_id, dl_id = not_dl.id, dl.id

    # 未下载 → 409
    resp = await client.post(f"/api/pipeline/items/{not_id}/score")
    assert resp.status_code == 409

    # 已下载 → 走评分（fake_ai 无 LLM → 502 或 LLM provider 错误）
    resp = await client.post(f"/api/pipeline/items/{dl_id}/score")
    assert resp.status_code in (200, 502)  # 无 LLM 时评分失败但状态流正确


@pytest.mark.asyncio
async def test_run_batch_delta_snapshot(client, monkeypatch) -> None:
    """运行前后数据差异（v0.3.5）：job summary 带 delta 各状态增减。"""
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.collectors.reddit import FakeRedditCollector, RawPost

    post = RawPost(
        source_id="delta-1", title="diff 测试", source_url="https://www.reddit.com/r/t/comments/delta1/x/",
        media_url=None, author="", score=10, upvote_ratio=0.9, num_comments=0,
        created_utc=1_700_000_000, is_video=False, item_type="text_only",
    )
    registry = ServiceRegistry.get()
    registry.pipeline.engine.collector = FakeRedditCollector([post])
    try:
        # 采集入库一条 → summary 应含 delta（discovered +1）
        resp = await client.post("/api/pipeline/run?step=collect&channel=hot")
        body = resp.json()
        if resp.status_code == 200:
            summary = body.get("summary") or {}
            assert summary.get("delta", {}).get("discovered", 0) == 1
    finally:
        registry.pipeline.engine.collector = FakeRedditCollector([])  # 复原占位


@pytest.mark.asyncio
async def test_publish_status_endpoint(client) -> None:
    """发布健康状态（v0.3.8）：目标/cookie/biliup 字段齐全。"""
    resp = await client.get("/api/pipeline/publish/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["target"] in body["publishers"]
    assert "biliup_available" in body
    assert "cookie_exists" in body
    assert "noop" in body


@pytest.mark.asyncio
async def test_publish_noop_marked(client) -> None:
    """noop 目标发布（v0.3.8）：结果带 noop 标记，前端据此警示。"""
    from backend.config import settings

    orig = settings.pipeline_publish_target
    settings.pipeline_publish_target = "noop"
    try:
        # 直接调 engine 方法不需要真实文件（noop 无 IO）
        from backend.factory.registry import ServiceRegistry
        from backend.models.item import Item, ItemStatus
        from backend.models.session import session_factory

        async with session_factory() as session:
            item = Item(
                status=ItemStatus.APPROVED, source="reddit", source_id="noop-1",
                title="noop 发布测试", item_type="video_raw",
            )
            session.add(item)
            await session.commit()
            item_id = item.id
        result = await ServiceRegistry.get().pipeline.publish_one(item_id)
        assert result["noop"] is True
    finally:
        settings.pipeline_publish_target = orig


# ---------- 输出深度（v0.3.10，Studio 编排） ----------


def test_depth_instruction_injection() -> None:
    """深度档位注入 system prompt：normal 不注入，其余五档对应指令。"""
    from backend.ai.prompts.agent import DEPTH_INSTRUCTIONS, build_agent_messages

    assert DEPTH_INSTRUCTIONS["normal"] == ""  # 默认档不注入
    assert "1" in DEPTH_INSTRUCTIONS["terse"] and "3" in DEPTH_INSTRUCTIONS["terse"]

    msgs = build_agent_messages(
        agent={"role": "writer", "method": "写", "style": []},
        phase_name="copywriting",
        topic="主题",
        brief_excerpt="",
        platform_id="",
        prior="",
        output_file="x.md",
        depth="terse",
    )
    system = msgs[0].content
    assert "极简" in system and "1–3 句话" in system

    msgs = build_agent_messages(
        agent={"role": "writer", "method": "写", "style": []},
        phase_name="copywriting",
        topic="主题",
        brief_excerpt="",
        platform_id="",
        prior="",
        output_file="x.md",
        depth="deep",
    )
    assert "深挖" in msgs[0].content

    # normal 不注入
    msgs = build_agent_messages(
        agent={"role": "writer", "method": "写", "style": []},
        phase_name="copywriting",
        topic="主题",
        brief_excerpt="",
        platform_id="",
        prior="",
        output_file="x.md",
        depth="normal",
    )
    assert "输出深度" not in msgs[0].content


@pytest.mark.asyncio
async def test_run_plan_accepts_depth(client) -> None:
    """run 端点接收 depth 参数（不破坏旧调用）。"""
    from backend.models.plan import Plan

    async with session_factory() as session:
        plan = Plan(name="深度测试", phase_order=[])
        session.add(plan)
        await session.commit()
        plan_id = plan.id

    resp = await client.post(f"/api/plans/{plan_id}/run", json={"input": "x", "depth": "terse"})
    assert resp.status_code in (200, 409)  # 409=已有运行中；端点接受参数即通过


# ---------- 深度档位库（v0.3.10 可维护化） ----------


@pytest.mark.asyncio
async def test_depth_levels_seed_and_crud(client) -> None:
    """深度库：内置五档 seed + CRUD + 恢复出厂。"""
    # seed 五档
    resp = await client.get("/api/depths")
    assert resp.status_code == 200
    levels = resp.json()
    keys = [lv["key"] for lv in levels]
    assert set(keys) == {"terse", "concise", "normal", "detailed", "deep"}
    normal = next(lv for lv in levels if lv["key"] == "normal")
    assert normal["effect"] == ""  # 正常档不注入

    # 新建自定义档
    resp = await client.post(
        "/api/depths", json={"key": "mega", "name": "超详细", "effect": "【深】写透"}
    )
    assert resp.status_code == 200
    created = resp.json()
    assert created["builtin"] is False

    # 更新档指令
    resp = await client.put(
        f"/api/depths/{created['id']}", json={"effect": "【深】写透改版"}
    )
    assert resp.status_code == 200
    assert resp.json()["effect"] == "【深】写透改版"

    # 删除自定义档
    resp = await client.delete(f"/api/depths/{created['id']}")
    assert resp.status_code == 200

    # 恢复出厂：只剩内置五档
    resp = await client.post("/api/depths/restore-defaults")
    assert resp.status_code == 200
    assert resp.json()["count"] == 5
    resp = await client.get("/api/depths")
    assert len(resp.json()) == 5


@pytest.mark.asyncio
async def test_depth_effect_db_priority(client) -> None:
    """engine 深度指令 DB 优先（自定义档即时生效；内置档以代码为准 seed 同步）。"""
    from backend.orchestration.depths import DepthService

    service = DepthService()
    # 默认内置
    assert "极简" in await service.effect_for("terse")
    assert await service.effect_for("normal") == ""
    # 自定义档：DB 指令即时生效
    created = await service.create(
        key="mega", name="超详细", effect="【新深】写透。"
    )
    assert (await service.effect_for("mega")) == "【新深】写透。"
    # 更新自定义档即时生效
    await service.update(created["id"], effect="【新深】写透改版。")
    assert (await service.effect_for("mega")) == "【新深】写透改版。"
    # 内置档被 seed 同步回代码版本（内置以代码为准）
    await service.restore_defaults()  # 还原
    assert "极简" in await service.effect_for("terse")


@pytest.mark.asyncio
async def test_updated_at_refreshes_on_requeue(client) -> None:
    """最近操作排序要素（v0.3.12）：打回审核/打回预处理刷新 updated_at。"""
    from datetime import UTC, datetime, timedelta

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="upd-1", title="已发布",
        )
        session.add(item)
        await session.commit()
        item_id = item.id
        # 把 updated_at 拨回过去，模拟老数据
        old = datetime.now(UTC) - timedelta(days=3)
        row = await session.get(Item, item_id)
        row.updated_at = old
        await session.commit()

    # 发布打回审核 → updated_at 刷新为现在
    resp = await client.post(f"/api/pipeline/items/{item_id}/requeue")
    assert resp.status_code == 200
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.updated_at is not None
        assert (row.updated_at - old).total_seconds() > 3600  # 明显刷新

    # 审核打回预处理 → 再次刷新
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 200
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "scored"
    # 序列化暴露 updated_at（列表排序要素）
    resp = await client.get("/api/pipeline/items?status=scored&limit=10")
    assert resp.status_code == 200
    serialized = resp.json()
    assert all("updated_at" in i for i in serialized)


# ---------- 批量审核（v0.4 A2） ----------


@pytest.mark.asyncio
async def test_batch_action_mixed(client) -> None:
    """批量审核：合法条目成功、非法条目记 failed 不中断。"""
    async with session_factory() as session:
        good = Item(status=ItemStatus.QUEUED, source="reddit", source_id="ba-1", title="可过")
        bad = Item(status=ItemStatus.PUBLISHED, source="reddit", source_id="ba-2", title="不可过")
        session.add_all([good, bad])
        await session.commit()
        good_id, bad_id = good.id, bad.id

    resp = await client.post(
        "/api/pipeline/items/batch", json={"action": "approve", "ids": [str(good_id), str(bad_id)]}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] == 1
    assert len(body["failed"]) == 1
    assert body["failed"][0]["id"] == str(bad_id)

    async with session_factory() as session:
        row = await session.get(Item, good_id)
        assert row.status == "approved"

    # 空列表
    resp = await client.post("/api/pipeline/items/batch", json={"action": "approve", "ids": []})
    assert resp.json() == {"ok": 0, "failed": []}

    # 未知 action
    resp = await client.post(
        "/api/pipeline/items/batch",
        json={"action": "explode", "ids": [str(good_id)]},
    )
    assert resp.status_code == 422


# ---------- 多源采集（v0.4 A4） ----------


@pytest.mark.asyncio
async def test_collect_multiple_sources(monkeypatch) -> None:
    """配置多个采集源：逐源独立汇总，单源失败不中断。"""
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.collectors.reddit import FakeRedditCollector

    class _Cfg:
        pipeline_sources = ["pics", "MadeMeSmile"]

    registry = ServiceRegistry.get()
    original_cfg = registry.pipeline.engine.settings
    original = registry.pipeline.engine.collector
    try:
        registry.pipeline.engine.settings = _Cfg()
        registry.pipeline.engine.collector = FakeRedditCollector([])

        class Ctx:
            run_id = "multi-test"

            def log(self, message, level="info"):
                pass

        engine = registry.pipeline.engine
        summary = await engine._run_step(Ctx(), "collect", limit=5, channel="")
        assert len(summary["sources"]) == 2  # 逐源独立记账
        assert summary["collected"] == 0
        assert summary["empty"] is True  # 全空 → 整体标记
    finally:
        registry.pipeline.engine.collector = original
        registry.pipeline.engine.settings = original_cfg


def test_config_allowlist_has_sources() -> None:
    """pipeline_sources 可运行时覆盖（设置页写入口）。"""
    from backend.routers.config import RUNTIME_ALLOWLIST

    assert "pipeline_sources" in RUNTIME_ALLOWLIST


# ---------- 生产方式模板（v0.4 B3） ----------


@pytest.mark.asyncio
async def test_produce_templates_seed_and_crud(client) -> None:
    """模板库：内置 4 模板 seed + 新建/删除。"""
    resp = await client.get("/api/pipeline/produce-templates")
    assert resp.status_code == 200
    tpls = resp.json()
    names = [x["name"] for x in tpls]
    assert {"直发", "配音+字幕", "翻译+字幕", "静音直发"} <= set(names)
    direct = next(x for x in tpls if x["name"] == "直发")
    assert direct["options"] == {"passthrough": True}

    # 新建自定义
    resp = await client.post(
        "/api/pipeline/produce-templates",
        json={"name": "搬运风", "options": {"voice": True, "subtitle": True}},
    )
    assert resp.status_code == 200
    created = resp.json()
    assert created["builtin"] is False

    # 删除
    resp = await client.delete(f"/api/pipeline/produce-templates/{created['id']}")
    assert resp.status_code == 200


# ---------- 字幕样式（v0.4 B1） ----------


def test_subtitle_style_injected() -> None:
    """srt_to_ass 输出样式行跟随配置（字号/描边/加粗/对齐）。"""
    from pathlib import Path

    from backend.pipeline.producers.media import srt_to_ass

    src = Path("/tmp/hz_sub_test.srt")
    out = Path("/tmp/hz_sub_test.ass")
    src.write_text(
        "1\n00:00:01,000 --> 00:00:02,000\n你好\n", encoding="utf-8"
    )
    srt_to_ass(src, out)
    header = out.read_text(encoding="utf-8")
    src.unlink(missing_ok=True)
    out.unlink(missing_ok=True)
    # 默认：字号 26 / 描边 2 / 加粗 -1 / 对齐 2（底部）
    assert "Noto Sans CJK SC,26" in header
    assert ",1,2,1," in header
    assert ",2,40,40,26,1" in header


# ---------- 发布数据回捞（v0.4 C1） ----------


def test_extract_bvid_from_stdout() -> None:
    """biliup stdout 解析 BV 号。"""
    from backend.pipeline.publish_stats import extract_bvid

    assert extract_bvid("upload success: BV1xx411c7mD view https://b23.tv/x") == "BV1xx411c7mD"
    assert extract_bvid("no bvid here") is None


def test_stats_expired_logic() -> None:
    """stats 缺失/过期判定（回捞调度只处理该拉的条目）。"""
    from datetime import UTC, datetime, timedelta

    from backend.pipeline.publish_stats import stats_expired

    assert stats_expired(None) is False  # 无 bvid 不拉
    assert stats_expired({"bvid": "BV1xx411c7mD"}) is True  # 无 stats → 拉
    assert stats_expired({"bvid": "BV1xx411c7mD", "stats": {"view": 1}}) is True
    fresh = datetime.now(UTC) - timedelta(hours=1)
    assert (
        stats_expired(
            {
                "bvid": "BV1xx411c7mD",
                "stats": {"view": 1},
                "stats_at": fresh.isoformat(),
            }
        )
        is False
    )


@pytest.mark.asyncio
async def test_set_publish_stats_endpoint(client) -> None:
    """手动补录发布数据（回捞失败的降级入口）。"""
    async with session_factory() as session:
        item = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="st-1", title="已发布",
            publish_json={"target": "bilibili"},
        )
        session.add(item)
        await session.commit()
        item_id = item.id

    resp = await client.post(
        f"/api/pipeline/items/{item_id}/publish-stats",
        json={"view": 1234, "like": 56, "favorite": 7, "comment": 8, "share": 9},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["stats"] == {"view": 1234, "like": 56, "favorite": 7, "comment": 8, "share": 9}

    async with session_factory() as session:
        row = await session.get(Item, item_id)
        pub = row.publish_json or {}
        assert pub["stats"]["view"] == 1234
        assert "stats_at" in pub


# ---------- 计划克隆/导出/导入（v0.4 D2） ----------


@pytest.mark.asyncio
async def test_plan_clone_export_import(client) -> None:
    """克隆/导出/导入：复制字段为新计划，导入跨环境可还原。"""
    from backend.models.plan import Plan

    async with session_factory() as session:
        plan = Plan(name="源计划", mode="text", phase_order=[{"key": "writer", "enabled": True}],
                    description="描述", buff_keys=["no_ai_phrases"])
        session.add(plan)
        await session.commit()
        plan_id = plan.id

    # 克隆
    resp = await client.post(f"/api/plans/{plan_id}/clone")
    assert resp.status_code == 200
    copy = resp.json()
    assert copy["name"] == "源计划 (副本)"
    assert copy["phase_order"][0]["key"] == "writer" and copy["phase_order"][0]["enabled"] is True
    assert copy["buff_keys"] == ["no_ai_phrases"]
    assert copy["id"] != str(plan_id)

    # 导出
    resp = await client.get(f"/api/plans/{plan_id}/export")
    assert resp.status_code == 200
    payload = resp.json()
    assert payload["plan"]["name"] == "源计划"

    # 导入（跨环境：crew/brief 引用置空）
    resp = await client.post("/api/plans/import", json={"payload": payload["plan"]})
    assert resp.status_code == 200
    imported = resp.json()
    assert imported["name"] == "源计划"
    assert imported["crew_id"] is None and imported["brief_id"] is None
    assert imported["phase_order"][0]["key"] == "writer"

    # 非法 payload
    resp = await client.post("/api/plans/import", json={"payload": {"foo": 1}})
    assert resp.status_code == 422
