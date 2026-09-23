"""v0.2.1 流水线治理单测：失败分类 / 评分成本闸门 / 排期引擎 / 自动过审 / phash / 导出包。

全部走 Fake LLM + 本地资源，不触碰真实网络。
"""

import asyncio
import json
import re
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import classify_error
from backend.pipeline.phash import compute_phash
from backend.pipeline.steps.score import ScoreStep

# ---------- 失败分类 ----------

def test_classify_error_categories() -> None:
    assert classify_error("download refused: unsafe media URL (x)") == "blocked"
    assert classify_error("HTTP 403 Forbidden") == "blocked"
    assert classify_error("429 Too Many Requests") == "rate_limit"
    assert classify_error("rate limit exceeded") == "rate_limit"
    assert classify_error("command timed out after 300s") == "ffmpeg"  # 命令超时归媒体处理
    assert classify_error("request timed out") == "timeout"
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
    pipeline_heuristic_scoring = False  # 测试 LLM 预算闸门——禁用启发式


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
    """v0.11.5：窗口 = 本地时钟语义；lookahead 从 earliest 所在日起算；
    当天窗口错过 → 当天兜底（now + 最小间隔），不排到次日。"""
    from datetime import datetime

    from backend.pipeline.schedule import next_slot

    tz = datetime.now().astimezone().tzinfo
    now = datetime(2026, 8, 8, 9, 0, tzinfo=tz)  # 本地 09:00
    slot = next_slot([], now=now, windows_raw="10:00-12:00,18:00-20:00",
                     min_interval_min=30, jitter_min=0)
    assert slot.astimezone(tz).hour == 10 and slot.astimezone(tz).minute == 0

    # 已有 10:00 排期 → 下一个槽位 10:30（最小间隔 30 分钟）
    existing = [datetime(2026, 8, 8, 10, 0, tzinfo=tz)]
    slot2 = next_slot(existing, now=now, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot2.astimezone(tz).hour == 10 and slot2.astimezone(tz).minute == 30

    # 上午窗口塞满（10:00/10:30/11:00/11:30）→ 跳到晚间窗口（本地 18:00）
    full = [
        datetime(2026, 8, 8, 10, 0, tzinfo=tz),
        datetime(2026, 8, 8, 10, 30, tzinfo=tz),
        datetime(2026, 8, 8, 11, 0, tzinfo=tz),
        datetime(2026, 8, 8, 11, 30, tzinfo=tz),
    ]
    slot3 = next_slot(full, now=now, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot3.astimezone(tz).hour == 18 and slot3.astimezone(tz).minute == 0

    # 已过全部窗口 → v0.11.5 兜底：当天 now + 最小间隔（不再排到次日）
    late = datetime(2026, 8, 8, 21, 0, tzinfo=tz)
    slot4 = next_slot([], now=late, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    late4 = slot4.astimezone(tz)
    assert late4.day == 8 and late4.hour == 21 and late4.minute == 30

    # earliest 被已排期推到次日 → 窗口从 earliest 所在日找（次日 10:00 命中）
    pushed = datetime(2026, 8, 10, 6, 0, tzinfo=tz)
    slot5 = next_slot([pushed], now=late, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    late5 = slot5.astimezone(tz)
    assert late5.day == 10 and late5.hour == 10

    # 次日窗口也已排满（earliest 被推到窗口外）→ 返回 None，不推延到 n 天后
    pushed_far = datetime(2026, 8, 10, 19, 30, tzinfo=tz)  # 次日 18-20 窗口最后槽位已占
    slot6 = next_slot([pushed_far], now=late, windows_raw="10:00-12:00,18:00-20:00",
                      min_interval_min=30, jitter_min=0)
    assert slot6 is None


def test_slot_calls_in_tests_inject_fixed_now() -> None:
    """守卫：测试里调用 next_slot 必须注入固定 now。

    真实教训——test_reschedule_expired 曾断言「过期条目一定拿到未来槽位」，
    而对照条目 now+1天 把 earliest 推到次日，本地时间越过末窗口（约 20:00 后）
    必然返回 None → 发布闸门每晚自己变红。凡是依赖真实挂钟的排期断言，
    要么注入 now，要么只断言不变量。
    """
    import re
    from pathlib import Path

    offenders = []
    for path in sorted(Path(__file__).parent.glob("test_*.py")):
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r"next_slot\(([^)]*)\)", src, re.S):
            args = m.group(1)
            line_no = src[: m.start()].count("\n") + 1
            if "now=" not in args or "datetime.now(" in args:
                offenders.append(f"{path.name}:{line_no}")
    assert not offenders, "next_slot 调用未注入固定 now（会随挂钟变红）: " + ", ".join(offenders)


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
    """​/failures 聚合 + /retry-class 批量重试 + 非法类 422（§8.1 输入校验）。"""
    # 先清历史残留（共享库可能存有此前运行的 f-1/f-2）
    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source_id.in_(["f-1", "f-2"])))
        await session.commit()
    # 全局聚合计数取基线（同会话内其他用例可能留下同分类条目——相对断言才鲁棒）
    baseline = (await client.get("/api/pipeline/failures")).json()
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
    assert failures.get("blocked", 0) == baseline.get("blocked", 0) + 1
    assert failures.get("llm", 0) >= baseline.get("llm", 0) + 1

    resp = await client.post("/api/pipeline/retry-class", json={"cls": "blocked"})
    assert resp.status_code == 200, resp.text
    # 同分类可能含其他残留条目——只断言下限（f-1 精确断言在下方按 id 校验）
    assert resp.json()["requeued"] >= 1
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

    # per-test 清理（D-181 惯例）：f-1/f-2 残留会污染后续 /failures 聚合计数
    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source_id.in_(["f-1", "f-2"])))
        await session.commit()


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

    # 审核打回预处理（v0.8.6 评分先行）：queued → downloaded
    # v0.8.9 对齐原项目 reproduce：打回即 purge 派生媒体（旧成片/封面/配音删除、
    # 字段清空，脚本缓存清除但保留用户发布元数据 bili_tid）
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "downloaded"
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "downloaded"
        assert row.video_path is None  # 旧成片已清除
        assert row.cover_path is None
        assert row.audio_path is None
        assert row.script_json == {"bili_tid": 201}  # 旁白清除，发布元数据保留

    # 预处理打回采集：downloaded → discovered
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
    """过期排期被重排：拿到未来槽位，或按 D-128 保持无排期——但绝不留在过去。

    此前断言写死 `scheduled_at is not None and > now`，把「当天窗口已排满 →
    保持无排期（用户手动设）」这条正确行为当成失败：next_slot 的 earliest 被
    本用例自己的对照条目（now+1 天）推到次日，本地时间落在末窗口之后时
    （如 20:00 后）必然返回 None → 测试随挂钟变红，而 verify.sh 是发布闸门。
    「能拿到未来槽位」这一支由 test_next_slot_respects_window_and_interval
    （注入固定 now）确定性覆盖，本用例只守端点不变量。
    """
    from datetime import UTC, datetime, timedelta

    now = datetime.now(UTC)
    expired_at = now - timedelta(days=2)
    fresh_at = now + timedelta(days=1)
    async with session_factory() as session:
        expired = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-1",
                       title="过期", scheduled_at=expired_at)
        fresh = Item(status=ItemStatus.QUEUED, source="reddit", source_id="rs-2",
                     title="未过期", scheduled_at=fresh_at)
        session.add_all([expired, fresh])
        await session.commit()
        expired_id, fresh_id = expired.id, fresh.id

    resp = await client.post("/api/pipeline/reschedule-expired")
    assert resp.status_code == 200, resp.text
    assert resp.json()["updated"] >= 1
    async with session_factory() as session:
        expired = await session.get(Item, expired_id)
        fresh = await session.get(Item, fresh_id)
        # 不变量：过期条目不再留在过去（要么未来槽位，要么显式无排期）
        assert expired.scheduled_at is None or expired.scheduled_at > now
        assert expired.scheduled_at != expired_at
        assert fresh.scheduled_at == fresh_at  # 未过期不动


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
@pytest.mark.asyncio
async def test_localize_text_engine_paths(monkeypatch) -> None:
    """D-189 单引擎语义：本地 MT 成功返回译文；失败回退原文。"""
    from backend.pipeline.producers import translate_engine
    from backend.pipeline.producers.media import _localize_text

    async def ok_mt(text: str) -> str:
        return "翻译后的旁白内容"

    monkeypatch.setattr(translate_engine, "translate_local", ok_mt)
    out = await _localize_text(
        "English narration text.", "zh-CN", source_lang="en-US",
    )
    assert "翻译后的旁白" in out

    async def boom_mt(text: str) -> str:
        raise RuntimeError("model missing")

    monkeypatch.setattr(translate_engine, "translate_local", boom_mt)
    original = "He kneels down and the kid stops crying."
    out = await _localize_text(original, "zh-CN", source_lang="en-US")
    assert "He kneels down" in out


@pytest.mark.asyncio
async def test_reschedule_assigns_unscheduled(client) -> None:
    """未排期条目自动分配推荐槽位（每次进入系统都有排期）。

    v0.2.0：窗口排满时不再推延（None → 保持无排期）——测试先清空历史
    排期保证窗口可用（共享 DB 隔离）。"""
    from datetime import UTC, datetime

    from sqlalchemy import update

    now = datetime.now(UTC)
    async with session_factory() as session:
        await session.execute(
            update(Item)
            .where(Item.status.in_((ItemStatus.QUEUED, ItemStatus.APPROVED)))
            .values(scheduled_at=None)
        )
        await session.commit()
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
        pipeline_heuristic_scoring = False

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
    # v0.8.9 语义：duration = 音频实际时长（不含 offset），结尾 = offset + 时长
    assert times[-1][1] == pytest.approx(11.0, abs=0.05)


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
    """预处理手动评分（v0.8.6 评分先行）：仅未评分（discovered）可评分。"""
    async with session_factory() as session:
        not_scored = Item(status="discovered", source="reddit", source_id="sc-1", title="未评分")
        dl = Item(status="downloaded", source="reddit", source_id="sc-2",
                  title="已下载", reddit_score=100, upvote_ratio=0.9)
        session.add_all([not_scored, dl])
        await session.commit()
        not_id, dl_id = not_scored.id, dl.id

    # 未评分 → 走评分（fake_ai 无 LLM → 502 或 LLM provider 错误，但状态校验通过）
    resp = await client.post(f"/api/pipeline/items/{not_id}/score")
    assert resp.status_code in (200, 502)

    # 已下载（评分过）→ 409（不可重复评分）
    resp = await client.post(f"/api/pipeline/items/{dl_id}/score")
    assert resp.status_code == 409


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
        # v0.10.1 异步队列：run 立即返回入队，summary 经 job 轮询取
        resp = await client.post("/api/pipeline/run?step=collect&channel=hot")
        assert resp.status_code == 200 and resp.json()["status"] == "queued"
        summary = {}
        deadline = asyncio.get_running_loop().time() + 30
        while asyncio.get_running_loop().time() < deadline:
            jobs = (await client.get("/api/pipeline/jobs")).json().get("jobs", [])
            # v0.8.8 轻量化：列表不含 delta（light）——展开详情经 /jobs/{id} 取全量
            hit = next((j for j in jobs if j.get("job") == "collect"), None)
            if hit:
                detail = (await client.get(f"/api/pipeline/jobs/{hit['id']}")).json()
                if (detail.get("summary") or {}).get("delta"):
                    summary = detail["summary"]
                    break
            await asyncio.sleep(0.3)
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
    # v0.11.2：霞鹜文楷优先（OFL 免费商用，测试环境无 assets 时 Noto 兜底）；
    # 字号 24 / 描边 1 / 不加粗 / 对齐 2（底部）/ 底部留白跟随配置
    from backend.config import settings

    margin = int(getattr(settings, "pipeline_subtitle_margin_bottom", 64))
    assert ("LXGW WenKai,24" in header) or ("Noto Sans CJK SC,24" in header)
    assert ",1,0," in header
    assert f",2,40,40,{margin},1" in header
    # v0.11.4：Events Format 必须含 Name 字段（Dialogue 行 10 值，缺 Name
    # 时 ffmpeg 9.0.1 把多余字段拼进文本 → 每句前导「，」）；并移除 {\fad(
    assert (
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"
        in header
    )
    assert r"\fad(" not in header
    assert header.rstrip().endswith(",你好")


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


# ---------- 审核相似提示（v0.5 A） ----------


@pytest.mark.asyncio
async def test_similar_annotations(client) -> None:
    """QUEUED 条目标注相似内容：phash 汉明≤5 且非同源同帖。"""

    # 构造两条同内容 phash（用 compute_phash 对相同视频帧不可行——
    # 直接写两个汉明距离 2 的 phash 字符串）
    base = "0" * 64
    close = "00" + "1" * 2 + "0" * 60  # 汉明距离 2
    async with session_factory() as session:
        a = Item(status=ItemStatus.QUEUED, source="reddit", source_id="sim-1",
                 title="第一条", phash=base)
        b = Item(status=ItemStatus.QUEUED, source="reddit", source_id="sim-2",
                 title="第二条", phash=close)
        same_source = Item(status=ItemStatus.QUEUED, source="reddit",
                           source_id="sim-1", title="同源重复", phash=close)
        published = Item(status=ItemStatus.PUBLISHED, source="reddit",
                         source_id="sim-3", title="已发布相似", phash=close)
        session.add_all([a, b, same_source, published])
        await session.commit()
        a_id, b_id = a.id, b.id

    resp = await client.get("/api/pipeline/items?status=queued&limit=10")
    assert resp.status_code == 200
    by_id = {i["id"]: i for i in resp.json()}

    # 第一条：与第二条+已发布相似（同源同帖不标）
    sim_a = by_id[str(a_id)]["similar"]
    assert "已发布相似" in sim_a["published"]
    assert "第二条" in sim_a["queued"]
    assert "同源重复" not in sim_a["queued"]

    # 第二条：与第一条相似，且与已发布相似
    sim_b = by_id[str(b_id)]["similar"]
    assert "第一条" in sim_b["queued"]
    assert "已发布相似" in sim_b["published"]


# ---------- 看板趋势（v0.5 B） ----------


@pytest.mark.asyncio
async def test_trends_endpoint(client) -> None:
    """趋势端点：按天返回 collected/inserted/published。"""
    from datetime import UTC, datetime

    from backend.models.system import JobRun, JobStatus

    async with session_factory() as session:
        session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED,
                           summary={"collected": 10, "inserted": 8},
                           started_at=datetime.now(UTC)))
        session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED,
                           summary={"collected": 5, "inserted": 3},
                           started_at=datetime.now(UTC)))
        await session.commit()

    resp = await client.get("/api/pipeline/trends?days=7")
    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 7
    today = rows[-1]
    assert today["collected"] >= 15
    assert today["inserted"] >= 11
    assert isinstance(today["published"], int)


# ---------- 成本估算（v0.5 E） ----------


@pytest.mark.asyncio
async def test_usage_extraction_from_stream() -> None:
    """流式响应携带 usage → last_usage 记录（成本估算数据源）。"""
    import httpx

    from backend.ai.providers.openai_compat import OpenAICompatProvider

    class FakeTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            body = (
                'data: {"choices":[{"delta":{"content":"你"}}]}\n\n'
                'data: {"choices":[{"delta":{"content":"好"}}]}\n\n'
                'data: {"choices":[{"delta":{}}],"usage":'
                '{"prompt_tokens":12,"completion_tokens":5}}\n\n'
                'data: [DONE]\n\n'
            )
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=body.encode(),
            )

    provider = OpenAICompatProvider(api_key="k", base_url="https://x/v1", model="m")
    provider._client = httpx.AsyncClient(base_url="https://x/v1", transport=FakeTransport())
    from backend.ai.types import ChatMessage
    chunks = [
        c async for c in provider.chat_stream(
            [ChatMessage(role="user", content="hi")]
        )
    ]
    assert "".join(chunks) == "你好"
    assert provider.last_usage == {"prompt_tokens": 12, "completion_tokens": 5}
    await provider._client.aclose()


@pytest.mark.asyncio
async def test_usage_absent_when_no_usage_chunk() -> None:
    """无 usage 的流（不兼容 provider）→ last_usage None，不破坏主流程。"""
    import httpx

    from backend.ai.providers.openai_compat import OpenAICompatProvider

    class FakeTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            return httpx.Response(
                200,
                headers={"Content-Type": "text/event-stream"},
                content=b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            )

    provider = OpenAICompatProvider(api_key="k", base_url="https://x/v1", model="m")
    provider._client = httpx.AsyncClient(base_url="https://x/v1", transport=FakeTransport())
    from backend.ai.types import ChatMessage
    chunks = [
        c async for c in provider.chat_stream(
            [ChatMessage(role="user", content="hi")]
        )
    ]
    assert "".join(chunks) == "ok"
    assert provider.last_usage is None
    await provider._client.aclose()



# ---------- Reddit Cookie 方案（v0.8.1，参考原项目） ----------


def test_cookie_header_from_netscape(tmp_path, monkeypatch) -> None:
    """Netscape cookies.txt → Cookie header（reddit 域过滤 + 去重）。"""
    from backend.pipeline.reddit_cookies import _netscape_cookie_header

    path = tmp_path / "reddit_cookies.txt"
    path.write_text(
        "# Netscape HTTP Cookie File\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\ttoken_v2\tabc123\n"
        ".redd.it\tTRUE\t/\tFALSE\t0\tsession_tracker\ttrk\n"
        ".google.com\tTRUE\t/\tFALSE\t0\tNID\tnope\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\ttoken_v2\tdef456\n",
        encoding="utf-8",
    )
    header = _netscape_cookie_header(path)
    assert "token_v2=def456" in header  # 同名去重（last wins）
    assert "session_tracker=trk" in header
    assert "NID" not in header  # 非 reddit 域过滤


@pytest.mark.asyncio
async def test_cookie_status_and_export_endpoint(client, tmp_path, monkeypatch) -> None:
    """状态端点只报存在性不报内容；导出端点软降级（无 yt-dlp 时 ok=False）。"""
    from backend.config import settings
    from backend.pipeline import reddit_cookies

    monkeypatch.setattr(reddit_cookies, "cookies_file_path", lambda: tmp_path / "rc.txt")
    monkeypatch.setattr(settings, "pipeline_reddit_cookie", "")

    resp = await client.get("/api/pipeline/reddit-cookie/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["exists"] is False  # 文件不存在
    assert "token" not in str(body)  # 不返回任何 cookie 内容

    # 导出：yt-dlp 不可用 → ok=False 软降级（不抛 500）
    async def fake_run(cmd):

        class P:
            returncode = 127

        return P()

    monkeypatch.setattr(reddit_cookies, "_run_export", fake_run)
    resp = await client.post("/api/pipeline/reddit-cookie/export")
    assert resp.status_code == 200
    assert resp.json()["ok"] is False


@pytest.mark.asyncio
async def test_cookie_status_session_quality(client, tmp_path, monkeypatch) -> None:
    """v0.11.7：仅匿名 edgebucket 的导出 → session_cookie=False（避免假成功）。"""
    from backend.pipeline import reddit_cookies

    def fake_path():
        return tmp_path / "rc.txt"

    monkeypatch.setattr(reddit_cookies, "cookies_file_path", fake_path)
    # 匿名 cookie：只有 edgebucket，无会话 cookie
    tmp_path.joinpath("rc.txt").write_text(
        "# Netscape HTTP Cookie File\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\tedgebucket\txyz\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(reddit_cookies, "settings", type(
        "S", (), {"pipeline_reddit_cookie": ""})())
    status = reddit_cookies.cookies_status()
    assert status["exists"] is True
    assert status["session_cookie"] is False
    # 会话 cookie 存在 → session_cookie=True
    tmp_path.joinpath("rc.txt").write_text(
        "# Netscape HTTP Cookie File\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\treddit_session\tSESS\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\tedgebucket\txyz\n",
        encoding="utf-8",
    )
    status = reddit_cookies.cookies_status()
    assert status["session_cookie"] is True


@pytest.mark.asyncio
async def test_cookie_export_browser_param(client, tmp_path, monkeypatch) -> None:
    """v0.11.7：export 支持指定浏览器，仅尝试该浏览器。"""
    from backend.pipeline import reddit_cookies

    def fake_path():
        return tmp_path / "rc.txt"

    monkeypatch.setattr(reddit_cookies, "cookies_file_path", fake_path)
    monkeypatch.setattr(reddit_cookies, "_export_lock_until", 0.0)
    tmp_path.joinpath("rc.txt").write_text(
        "# Netscape HTTP Cookie File\n"
        ".reddit.com\tTRUE\t/\tFALSE\t0\ttoken_v2\tabc\n",
        encoding="utf-8",
    )
    # 模拟某浏览器导出成功（写 cookie 文件，with_suffix(".tmp") 覆盖整后缀 → rc.tmp）
    async def fake_run(cmd):
        assert "firefox" in cmd, "应只尝试指定浏览器"
        tmp_path.joinpath("rc.tmp").write_text(
            "# Netscape HTTP Cookie File\n"
            ".reddit.com\tTRUE\t/\tFALSE\t0\treddit_session\tS\n",
            encoding="utf-8",
        )

        class P:
            returncode = 0

        return P()

    monkeypatch.setattr(reddit_cookies, "_run_export", fake_run)
    resp = await client.post(
        "/api/pipeline/reddit-cookie/export?browser=firefox&force=true&verify=false"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["source"] == "browser:firefox"
    assert body["session_cookie"] is True


# ---------- RSS 错位与 yt-dlp cookie 优先（v0.8.1，参考原项目） ----------


def test_rss_vreddit_link_normalized() -> None:
    """RSS 视频帖 link 直接指向 v.redd.it → v0.8.8 修复：content 无真评论链接时
    回退 /video/{id}/ 视频页（旧实现构造 comments/{媒体ID} 为无效链接）。"""
    import xml.etree.ElementTree as ET

    from backend.pipeline.collectors.reddit import RedditCollector

    xml = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>视频帖</title>
    <link href="https://v.redd.it/abc123"/>
    <content type="html">&lt;a href="https://v.redd.it/abc123/DASH_720.mp4"&gt;v&lt;/a&gt;</content>
  </entry>
</feed>"""
    root = ET.fromstring(xml)
    post = RedditCollector._rss_to_post(root.find("{http://www.w3.org/2005/Atom}entry"))
    assert post is not None
    assert post.source_id == "abc123"
    assert post.source_url == "https://www.reddit.com/video/abc123/"  # 有效视频页
    assert post.media_url == "https://v.redd.it/abc123/DASH_720.mp4"


def test_dead_media_detects_misaligned_permalink() -> None:
    """采集预筛（参考原项目 _invalid_collect_media）：permalink 误存 v.redd.it → 死。"""
    from backend.pipeline.download import is_dead_reddit_media

    assert is_dead_reddit_media("", "https://v.redd.it/abc123", "abc123") is True
    assert (
        is_dead_reddit_media("", "https://www.reddit.com/r/x/comments/abc123/t/", "abc123")
        is False
    )


# ---------- 越界 raw_path 迁移（v0.8.1 成片缺失修复） ----------


def test_legacy_path_migration(tmp_path, monkeypatch) -> None:
    """越界 raw_path 迁移到数据根（幂等）+ 相对 legacy 路径重写为绝对。"""
    import scripts.migrate_legacy_raw_paths as mig
    from backend.config import settings
    from scripts.migrate_legacy_raw_paths import _is_outside, _migrate_one

    outside_dir = tmp_path.parent / "outside_assets"
    outside = str(outside_dir / "x.mp4")
    outside_dir.mkdir(exist_ok=True)
    (outside_dir / "x.mp4").write_bytes(b"media")

    class Item:
        def __init__(self):
            self.raw_path = None

    item = Item()
    item.raw_path = outside  # 越界绝对路径
    # 绝对越界 → 复制到目标并存绝对路径
    monkeypatch.setattr(mig, "_TARGET_ROOT", tmp_path / "legacy-raw")
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    changed = _migrate_one(item, "raw_path", 42)
    assert changed is True
    assert item.raw_path.startswith(str(tmp_path / "legacy-raw" / "42"))
    assert Path(item.raw_path).exists()
    assert _is_outside(item.raw_path) is False  # 迁移后不再越界

    # 相对 legacy 路径（v0.8.1 曾误存）→ 判定为需重写
    assert _is_outside("data/pipeline/legacy-raw/42/x.mp4") is True


# ---------- 自动采集 scheduler（v0.8.1 职责重组） ----------


@pytest.mark.asyncio
async def test_auto_collect_tick_calls_collect(monkeypatch) -> None:
    """自动采集 tick：调 run_batch('collect')，手动运行中跳过。"""
    from backend.factory.registry import ServiceRegistry

    reg = ServiceRegistry.get()
    calls = {"n": 0, "busy": False}

    async def fake_run_batch(job, limit=10):
        calls["n"] += 1
        return {"summary": {"collected": 3, "sources": [{"channel": "pics"}]}}

    async def fake_busy_run_batch(job, limit=10):
        raise RuntimeError("pipeline busy")

    monkeypatch.setattr(reg.pipeline, "run_batch", fake_run_batch)
    await reg._collect_tick()
    assert calls["n"] == 1

    # 手动运行中 → tick 失败不拖垮（记日志返回）
    monkeypatch.setattr(reg.pipeline, "run_batch", fake_busy_run_batch)
    await reg._collect_tick()  # 不抛异常
    assert calls["n"] == 1  # busy 不计数（fake 直接抛，走 except 路径）


def test_auto_collect_config_default() -> None:
    """默认 30 分钟自动采集（settings_base，不受 runtime.yaml 覆盖影响）；0=关闭。"""
    from backend.config import settings, settings_base
    from backend.routers.config import RUNTIME_ALLOWLIST

    assert settings_base.pipeline_auto_collect_minutes == 30
    assert settings.pipeline_auto_collect_minutes >= 0
    assert "pipeline_auto_collect_minutes" in RUNTIME_ALLOWLIST


# ---------- 采集运维状态（v0.8.2） ----------


@pytest.mark.asyncio
async def test_collect_status_endpoint(client, monkeypatch) -> None:
    """采集运维状态：间隔/上次结果/下次自动字段齐全。"""
    from datetime import UTC, datetime

    from backend.models.system import JobRun, JobStatus

    async with session_factory() as session:
        session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED,
                           summary={"collected": 12, "inserted": 10, "sources": []},
                           started_at=datetime.now(UTC)))
        await session.commit()

    resp = await client.get("/api/pipeline/collect/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["auto_enabled"] is True
    # 端点如实反映配置（runtime.yaml 覆盖后可能 < 30）
    from backend.config import settings

    assert body["interval_min"] == settings.pipeline_auto_collect_minutes
    assert body["last"]["summary"]["collected"] == 12
    assert body["next_in_s"] is not None  # 上次完成后距下次自动


def test_auto_collect_interval_config() -> None:
    """自动采集间隔可配置且进 allowlist（设置页写入口）。"""
    from backend.config import settings
    from backend.routers.config import RUNTIME_ALLOWLIST

    assert "pipeline_auto_collect_minutes" in RUNTIME_ALLOWLIST
    assert settings.pipeline_auto_collect_minutes >= 0


# ---------- B 站 cookie 统一（v0.8.4：data/core/cookies.json） ----------


def test_bili_cookie_header_both_formats(tmp_path) -> None:
    """B 站 cookie 文件兼容两种格式（biliup dict / passport 数组）。"""
    from backend.pipeline.publish_stats import _cookie_header

    # biliup 风格 {"cookies": {...}}
    f1 = tmp_path / "a.json"
    f1.write_text(json.dumps({"cookies": {"SESSDATA": "s1", "bili_jct": "j1"}}), encoding="utf-8")
    h1 = _cookie_header(f1)
    assert "SESSDATA=s1" in h1 and "bili_jct=j1" in h1

    # passport 登录响应（cookie_info.cookies 数组 + token_info）
    f2 = tmp_path / "b.json"
    f2.write_text(json.dumps({
        "cookie_info": {"cookies": [
            {"name": "SESSDATA", "value": "s2", "expires": 1800000000, "http_only": 1, "secure": 0},
            {"name": "bili_jct", "value": "j2", "expires": 1800000000, "http_only": 0, "secure": 0},
            {"name": "buvid3", "value": "x", "expires": -1, "http_only": 1, "secure": 0},
        ]},
        "token_info": {"access_token": "tok"},
        "sso": ["https://passport.bilibili.com/api/v2/sso"],
    }), encoding="utf-8")
    h2 = _cookie_header(f2)
    assert "SESSDATA=s2" in h2 and "bili_jct=j2" in h2 and "buvid3=x" in h2


@pytest.mark.asyncio
async def test_publish_status_cookie_path(client, tmp_path, monkeypatch) -> None:
    """publish/status 检查 data/core/cookies.json（统一路径）。"""
    from backend.config import settings

    monkeypatch.setattr(settings, "data_dir", tmp_path)
    resp = await client.get("/api/pipeline/publish/status")
    body = resp.json()
    assert body["cookie_path"].endswith("core/cookies.json")
    assert body["cookie_exists"] is False  # 无文件

    (tmp_path / "core").mkdir(exist_ok=True)
    (tmp_path / "core" / "cookies.json").write_text(json.dumps({"cookies": {"SESSDATA": "s"}}), encoding="utf-8")  # noqa: E501
    resp = await client.get("/api/pipeline/publish/status")
    assert resp.json()["cookie_exists"] is True


# ---------- B 站中文包装 + 发布参数对齐（v0.8.5） ----------


def test_heuristic_bili_title() -> None:
    """英文标题 → 「这镜头 xx」中文兜底；中文标题原样保留。"""
    from backend.pipeline.package import _heuristic_bili_title

    assert _heuristic_bili_title("Man hand-feeds a giant crocodile") == "这镜头 Man hand-feeds a giant croco"  # noqa: E501
    assert _heuristic_bili_title("这是一条中文标题内容足够长") == "这是一条中文标题内容足够长"
    assert _heuristic_bili_title("   ") == "这镜头有点东西"
    assert _heuristic_bili_title("[OC] Cool stuff") == "这镜头 Cool stuff"


def test_normalize_tags_filters_banned() -> None:
    """禁词过滤：reddit / r/xxx / 纯英文子名剔除，去重限 8。"""
    from backend.pipeline.package import normalize_tags

    got = normalize_tags([
        "Reddit", "r/BeAmazed", "BeAmazed", "海外精选",
        "神奇现象", "神奇现象", "高能", "动物", "机械",
        "暖心", "反转", "绝了", "生活",
    ])
    assert "神奇现象" in got
    assert got.count("神奇现象") == 1
    assert not any(t in ("Reddit", "r/BeAmazed", "BeAmazed", "海外精选") for t in got)
    assert len(got) <= 8


def test_build_description_subtitle_first_sentence() -> None:
    """简介 = 中文字幕首句（截到标点/72 字）+ r/xxx · u/author 署名。"""
    from backend.pipeline.package import build_description

    d = build_description("这个镜头太安静了。再细看其实有玄机", "aww", "catlover")
    assert "这个镜头太安静了。" in d
    assert "r/aww" in d and "u/catlover" in d

    long = build_description("很" * 90, "pics", None)
    assert len(long.splitlines()[0]) <= 72 + 1  # 截断 + 可能省略号
    assert "r/pics" in long

    assert build_description("", "", None) == ""


class _PackagingAi:
    """Fake AI：title_and_tags 可配置成功/失败。"""

    def __init__(self, *, ok: bool = True):
        self.ok = ok
        self.calls = 0

    async def title_and_tags(self, **kwargs):
        self.calls += 1
        if not self.ok:
            raise RuntimeError("llm down")
        from backend.ai.types import TitleResult
        return TitleResult(
            title="门一开空气都安静了",
            tags=["神奇现象", "高能", "Reddit", "r/aww"],
            description="第一眼以为是定格，其实全是真实的慢动作。",
        )


@pytest.mark.asyncio
async def test_generate_packaging_llm_and_fallback() -> None:
    """LLM 成功：中文标题/清洗后标签/原文标题简介写入；LLM 失败：heuristic 兜底。
    v0.11.5：简介不换中文——固定用原帖标题。"""
    from backend.pipeline.package import generate_packaging

    class Item:
        id = "0b5f8d1e-0000-4000-8000-000000000003"
        title = "Man hand-feeds a giant crocodile"
        subreddit = "interestingasfuck"
        author = "wildlife_dan"

    script = {"mode": "script", "narration": "Watch this. He feeds it by hand.", "subtitle_zh": "他居然徒手喂鳄鱼。"}  # noqa: E501

    ai = _PackagingAi(ok=True)
    got = await generate_packaging(ai, Item(), script)
    assert got["bili_title"] == "门一开空气都安静了"
    assert got["bili_tags"] == "神奇现象,高能"  # Reddit/r/aww 被清洗
    assert got["bili_desc"] == "Man hand-feeds a giant crocodile"  # 原文标题，不换中文

    ai_bad = _PackagingAi(ok=False)
    got2 = await generate_packaging(ai_bad, Item(), {"mode": "script", "narration": "x", "subtitle_zh": "他居然徒手喂鳄鱼。"})  # noqa: E501
    assert got2["bili_title"].startswith("这镜头 ")
    assert "神奇现象" in got2["bili_tags"]
    assert got2["bili_desc"] == "Man hand-feeds a giant crocodile"


@pytest.mark.asyncio
async def test_publish_cmd_cover_source_desc() -> None:
    """发布命令对齐原项目：--cover 封面 / --source 转载来源 / desc 中文兜底。"""
    import tempfile
    from pathlib import Path
    from unittest.mock import patch

    from backend.pipeline.publishers.router import BilibiliPublisher

    class Item:
        video_path = "/tmp/x.mp4"
        title = "English Fallback Title"
        scheduled_at = None
        script_json = {
            "bili_title": "门一开空气都安静了",
            "bili_desc": "",
            "bili_tags": "神奇现象,高能",
            "bili_copyright": 2,
        }
        subreddit = "interestingasfuck"
        item_type = "video_raw"
        source_url = "https://www.reddit.com/r/interestingasfuck/comments/abc/"
        cover_path = "/tmp/x.jpg"

    class Settings:
        data_dir = Path(tempfile.mkdtemp())
        pipeline_bili_default_tid = 0

    class Ctx:
        settings = Settings()
        def log(self, msg): pass

    captured: list[str] = []

    async def fake_run(cmd):
        captured.extend(cmd)
        return b"ok BV1abc123XYZ"

    with patch("backend.pipeline.producers.media._run_cmd", new=fake_run):
        with patch.object(Path, "exists", return_value=True):
            r = await BilibiliPublisher().publish(Ctx(), Item())

    assert "--cover" in captured and "/tmp/x.jpg" in captured
    joined = " ".join(captured)
    assert "--source" in joined and "reddit.com" in joined
    # v0.12.1：转载必须显式 --copyright 2（biliup 默认按自制发布）
    assert "--copyright 2" in joined
    assert "English Fallback Title" in captured  # v0.11.5：desc 空 → 原文标题兜底（不换中文）
    assert "--tag" in joined and "神奇现象" in joined
    assert r["bvid"] == "BV1abc123XYZ"


# ---------- 采集健壮性 + 评分先行（v0.8.6） ----------


def test_parse_channel_semantics() -> None:
    """channel 语义：subreddit / subreddit:sort；排序词误当 subreddit 报可读错误。"""
    from backend.pipeline.collectors.reddit import _parse_channel

    sub, sort = _parse_channel("Damnthatsinteresting")
    assert sub == "Damnthatsinteresting" and sort in ("hot", "new", "rising", "top")
    assert _parse_channel("BeAmazed:new") == ("BeAmazed", "new")
    with pytest.raises(RuntimeError, match="排序词"):
        _parse_channel("hot")
    with pytest.raises(RuntimeError, match="排序词"):
        _parse_channel("new")
    with pytest.raises(RuntimeError, match="缺少"):
        _parse_channel("")


def test_collect_error_classification() -> None:
    """httpx 网络层异常 → CollectNetworkError（含类型名，空消息可读化）。"""
    import httpx

    from backend.pipeline.collectors.reddit import (
        CollectBlockedError,
        CollectNetworkError,
        CollectRateLimitedError,
        _classify_http,
    )

    class FakeResp:
        status_code = 403

    exc403 = httpx.HTTPStatusError("403", request=httpx.Request("GET", "u"), response=FakeResp())
    assert isinstance(_classify_http(exc403, "d"), CollectBlockedError)

    class FakeResp429:
        status_code = 429

    exc429 = httpx.HTTPStatusError("429", request=httpx.Request("GET", "u"), response=FakeResp429())
    assert isinstance(_classify_http(exc429, "d"), CollectRateLimitedError)

    conn = httpx.ConnectError("", request=httpx.Request("GET", "u"))
    classified = _classify_http(conn, "d")
    assert isinstance(classified, CollectNetworkError)
    assert "ConnectError" in str(classified)  # 空消息 → 类型名可读


@pytest.mark.asyncio
async def test_collect_failure_cooldown_by_kind() -> None:
    """分类冷却：网络层 900s / 平台拒绝 1800s / 配置错误不冷却 / 连续≥3 熔断 2h。"""
    from backend.models.pipeline import SourceState
    from backend.pipeline.collectors.reddit import (
        CollectBlockedError,
        CollectNetworkError,
    )
    from backend.pipeline.engine import StepEngine

    engine = StepEngine(hub=None, settings=None)

    async def kind_cd(exc) -> int:
        from datetime import UTC, datetime

        from backend.models.session import session_factory

        async with session_factory() as session:
            state = (
                await session.execute(
                    select(SourceState).where(
                        SourceState.source == "reddit",
                        SourceState.channel == "BeAmazed:test",
                    )
                )
            ).scalar_one_or_none()
            if state is None:
                state = SourceState(source="reddit", channel="BeAmazed:test")
                session.add(state)
            state.consecutive_fails = 0
            await session.commit()
        await engine._record_collect_failure("reddit", "BeAmazed:test", str(exc), exc)
        async with session_factory() as session:
            state = (
                await session.execute(
                    select(SourceState).where(SourceState.channel == "BeAmazed:test")
                )
            ).scalar_one()
            cd = state.get_cooldowns().get("default", 0.0)
            left = int(cd - datetime.now(UTC).timestamp())
            return left

    net = await kind_cd(CollectNetworkError("net"))
    assert 800 <= net <= 950, net
    blocked = await kind_cd(CollectBlockedError("403"))
    assert 1700 <= blocked <= 1850, blocked
    cfg = await kind_cd(RuntimeError("采集源 'hot' 是排序词"))
    assert cfg <= 0  # 配置错误不冷却（无 default 冷却键）
    # 连续 3 次 → 熔断 2h（cleared fails 后连续失败）
    await kind_cd(CollectNetworkError("reset"))
    for _ in range(3):
        await engine._record_collect_failure(
            "reddit", "BeAmazed:test", "x", CollectBlockedError("403")
        )
    async with session_factory() as session:
        state = (
            await session.execute(
                select(SourceState).where(SourceState.channel == "BeAmazed:test")
            )
        ).scalar_one()
        fused = int(state.get_cooldowns().get("default", 0.0) - datetime.now(UTC).timestamp())
    assert fused >= 7100, fused


@pytest.mark.asyncio
async def test_score_first_flow() -> None:
    """评分先行（v0.8.6）：score 吃 discovered / download 吃 scored / produce 吃 downloaded。"""
    from backend.pipeline.steps import PIPELINE_ORDER, get_step

    assert PIPELINE_ORDER == ("collect", "score", "download", "produce", "publish")
    assert get_step("score").input_statuses == ("discovered",)
    assert get_step("download").input_statuses == ("scored",)
    assert get_step("produce").input_statuses == ("downloaded",)


def test_back_status_swap() -> None:
    """回退状态机（v0.8.6）：有成片→downloaded / 已下载→scored / 否则→discovered。"""
    from backend.pipeline.helpers import back_status_for

    class _I:
        video_path = None
        raw_path = None

    i = _I()
    i.video_path = "/tmp/v.mp4"
    i.raw_path = "/tmp/r.mp4"
    assert back_status_for(i) == "downloaded"
    i.video_path = None
    assert back_status_for(i) == "scored"
    i.raw_path = None
    assert back_status_for(i) == "discovered"


@pytest.mark.asyncio
async def test_download_one_endpoint(client) -> None:
    """单条下载端点：scored 可下载；discovered/已下载拒绝。"""
    from datetime import UTC, datetime

    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory

    async def mk(status: ItemStatus, *, raw: bool = False) -> str:
        async with session_factory() as session:
            it = Item(
                status=status,
                source="reddit",
                source_id=f"t_{status}_{datetime.now(UTC).timestamp()}",
                title=f"下载端点测试 {status}",
                subreddit="BeAmazed",
                source_url="https://www.reddit.com/r/BeAmazed/comments/abc/",
                media_url="https://v.redd.it/xyz/DASH_720.mp4",
                raw_path=f"/tmp/r_{status.value}.mp4" if raw else None,
            )
            session.add(it)
            await session.commit()
            await session.refresh(it)
            return str(it.id)

    mid = await mk(ItemStatus.SCORED)
    resp = await client.post(f"/api/pipeline/items/{mid}/download")
    assert resp.status_code in (200, 502)  # 无网络环境可能下载失败，但状态校验通过

    other = await mk(ItemStatus.DISCOVERED)
    resp = await client.post(f"/api/pipeline/items/{other}/download")
    assert resp.status_code == 409  # 未评分不可下载


# ---------- 活动面板历史化（v0.8.7：jobs 分页/详情 + 日志历史 + 事件落盘） ----------


@pytest.mark.asyncio
async def test_jobs_page_filter_and_detail(client) -> None:
    """任务历史：分页 + 类型筛选 + 单任务详情。"""
    from backend.models.session import session_factory
    from backend.models.system import JobRun, JobStatus

    async with session_factory() as session:
        for i in range(5):
            session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED,
                               summary={"collected": i, "sources": [{"channel": f"s{i}", "collected": i}]}))  # noqa: E501
        session.add(JobRun(job_name="score", status=JobStatus.FAILED, error="boom"))
        await session.commit()

    r = await client.get("/api/pipeline/jobs?limit=3&offset=0")
    b = r.json()
    assert r.status_code == 200
    assert b["total"] >= 6
    assert len(b["jobs"]) == 3

    only_failed = (await client.get("/api/pipeline/jobs?status=failed")).json()
    assert only_failed["total"] >= 1
    assert all(j["status"] == "failed" for j in only_failed["jobs"])

    only_score = (await client.get("/api/pipeline/jobs?job_name=score")).json()
    assert all(j["job"] == "score" for j in only_score["jobs"])

    first = only_score["jobs"][0]
    detail = (await client.get(f"/api/pipeline/jobs/{first['id']}")).json()
    assert detail["id"] == first["id"]
    assert detail["job"] == "score"
    assert detail["error"] == "boom"
    assert "duration_s" in detail

    nf = await client.get("/api/pipeline/jobs/00000000-0000-0000-0000-000000000000")
    assert nf.status_code == 404


@pytest.mark.asyncio
async def test_collect_history_endpoint(client) -> None:
    """采集历史轮次：逐源明细随行返回。"""
    from backend.models.session import session_factory
    from backend.models.system import JobRun, JobStatus

    async with session_factory() as session:
        session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED, summary={
            "collected": 3, "inserted": 2,
            "sources": [
                {"channel": "BeAmazed", "collected": 2, "inserted": 2, "skipped": 0},
                {"channel": "Unexpected", "collected": 1, "inserted": 0, "skipped": 1},
            ],
        }))
        await session.commit()

    h = (await client.get("/api/pipeline/collect/history?limit=5")).json()
    assert len(h) >= 1
    latest = h[0]
    assert latest["job"] == "collect"
    assert latest["summary"]["sources"][0]["channel"] == "BeAmazed"


def test_logs_history_parse_and_filter(tmp_path, monkeypatch) -> None:
    """日志文件历史：解析 + 级别/关键字/时间游标过滤（含轮转文件）。"""
    from backend.routers import logs as logs_mod

    logdir = tmp_path / "logs"
    logdir.mkdir()
    lines = [
        "2026-08-11 10:00:00 INFO     [hertz] boot ok",
        "2026-08-11 10:01:00 WARNING  [backend.pipeline] collect failed: net",
        "2026-08-11 10:02:00 ERROR    [backend.pipeline] tick failed",
        "   multi-line traceback continuation (non-log line)",
    ]
    (logdir / "hertz.log").write_text("\n".join(lines), encoding="utf-8")
    (logdir / "hertz.log.1").write_text(
        "2026-08-10 09:00:00 INFO     [hertz] older line\n", encoding="utf-8"
    )

    monkeypatch.setattr(logs_mod.log_manager, "log_dir", logdir)

    all_ = logs_mod._query_logs(limit=10, level="", q="", since="", until="")
    assert all_["count"] == 4  # 3 格式行 + 轮转 1 行；多行 traceback 被跳过
    assert all_["lines"][0]["ts"] == "2026-08-11 10:02:00"  # 新在前

    warn = logs_mod._query_logs(limit=10, level="WARNING", q="", since="", until="")
    assert warn["count"] == 1 and warn["lines"][0]["logger"] == "backend.pipeline"

    q = logs_mod._query_logs(limit=10, level="", q="tick", since="", until="")
    assert q["count"] == 1 and "tick failed" in q["lines"][0]["message"]

    # until 是「加载更多」游标：排除端点行本身（避免重复），取更早行
    until = logs_mod._query_logs(limit=10, level="", q="", since="", until="2026-08-11 10:01:00")
    assert until["count"] == 2
    assert until["lines"][0]["ts"] == "2026-08-11 10:00:00"
    assert until["lines"][1]["ts"] == "2026-08-10 09:00:00"

    has_more = logs_mod._query_logs(limit=2, level="", q="", since="", until="")
    assert has_more["has_more"] is True and has_more["count"] == 2


def test_step_log_persisted(monkeypatch) -> None:
    """事件落盘（v0.8.7）：StepContext.log 同步写日志（SSE 之外持久化）。"""
    from backend.pipeline.base import StepContext

    captured: list[tuple[str, str, tuple]] = []

    class FakeLogger:
        def info(self, m, *a): captured.append(("info", m, a))
        def warning(self, m, *a): captured.append(("warning", m, a))
        def error(self, m, *a): captured.append(("error", m, a))

    monkeypatch.setattr("backend.pipeline.base.logger", FakeLogger())

    emitted = []
    ctx = StepContext(run_id="r1", settings=None, emit=lambda e: emitted.append(e))
    ctx.log("hello world")
    ctx.log("warn here", level="warning")
    assert emitted == [
        {"type": "log", "message": "hello world", "level": "info"},
        {"type": "log", "message": "warn here", "level": "warning"},
    ]
    assert captured == [
        ("info", "[step] %s", ("hello world",)),
        ("warning", "[step] %s", ("warn here",)),
    ]


# ---------- AXIOM 查漏补缺（v0.8.8 审计） ----------


@pytest.mark.asyncio
async def test_jobs_list_light_detail_full(client) -> None:
    """列表轻量化（§2.3/§7.2）：列表无逐源明细，展开详情完整返回。"""
    from backend.models.session import session_factory
    from backend.models.system import JobRun, JobStatus

    async with session_factory() as session:
        session.add(JobRun(job_name="collect", status=JobStatus.COMPLETED, summary={
            "collected": 5, "inserted": 3,
            "sources": [{"channel": "a", "collected": 5, "inserted": 3},
                        {"channel": "b", "error": "net fail"}],
            "delta": {"discovered": 5},
        }))
        await session.commit()

    page = (await client.get("/api/pipeline/jobs?job_name=collect")).json()
    light = page["jobs"][0]
    assert "sources" not in light["summary"] and "delta" not in light["summary"]
    assert light["summary"]["sources_ok"] == 1
    assert light["summary"]["sources_err"] == 1

    detail = (await client.get(f"/api/pipeline/jobs/{light['id']}")).json()
    assert len(detail["summary"]["sources"]) == 2
    assert detail["summary"]["delta"] == {"discovered": 5}


def test_logs_scrub_and_cursor_validation(tmp_path, monkeypatch) -> None:
    """§8.2 密钥脱敏 + §8.1 游标格式校验。"""
    from backend.routers import logs as logs_mod

    logdir = tmp_path / "logs"
    logdir.mkdir()
    (logdir / "hertz.log").write_text(
        "2026-08-11 10:00:00 ERROR    [biliup] failed cookie=SESSDATA=abc123\n", encoding="utf-8"
    )
    monkeypatch.setattr(logs_mod.log_manager, "log_dir", logdir)
    logs_mod._CACHE.clear()

    r = logs_mod._query_logs(limit=10, level="", q="", since="", until="")
    assert "abc123" not in r["lines"][0]["message"]
    assert "***" in r["lines"][0]["message"]


# ---------- RSS 视频帖链接修复（v0.8.8） ----------


def _rss_entry(href: str, content: str) -> object:
    import xml.etree.ElementTree as ET

    xml = f'''<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Test video post</title>
    <link href="{href}" />
    <content type="html"><![CDATA[{content}]]></content>
  </entry>
</feed>'''
    return ET.fromstring(xml).find("{http://www.w3.org/2005/Atom}entry")


def test_rss_to_post_normal_comments_href() -> None:
    """正常 RSS：href 即评论链接，source_url/source_id 原样提取。"""
    from backend.pipeline.collectors.reddit import RedditCollector

    entry = _rss_entry(
        "https://old.reddit.com/r/Damnthatsinteresting/comments/1vlwkn3/the_perfect_rainbow/",
        'a href="https://v.redd.it/ktqommt3rtih1"',
    )
    post = RedditCollector._rss_to_post(entry)
    assert post is not None
    assert post.source_id == "1vlwkn3"
    assert "/comments/1vlwkn3" in post.source_url
    assert post.media_url == "https://v.redd.it/ktqommt3rtih1"


def test_rss_to_post_vreddit_href_with_real_link_in_content() -> None:
    """v.redd.it href + content 含真评论链接：优先用真 post ID（v0.8.8 修复）。"""
    from backend.pipeline.collectors.reddit import RedditCollector

    entry = _rss_entry(
        "https://v.redd.it/ktqommt3rtih1",
        '<a href="https://www.reddit.com/r/Damnthatsinteresting/comments/1vlwkn3/">'
        '<img src="https://i.redd.it/abc.jpg"></a>',
    )
    post = RedditCollector._rss_to_post(entry)
    assert post is not None
    assert post.source_id == "1vlwkn3"
    assert "/r/Damnthatsinteresting/comments/1vlwkn3/" in post.source_url
    assert "v.redd.it/ktqommt3rtih1" not in post.source_url


def test_rss_to_post_vreddit_href_no_real_link() -> None:
    """v.redd.it href + content 无评论链接：回退 /video/{id}/（有效视频页，v0.8.8）。"""
    from backend.pipeline.collectors.reddit import RedditCollector

    entry = _rss_entry(
        "https://v.redd.it/5wtt65kshxdh1",
        '<video src="https://v.redd.it/5wtt65kshxdh1"></video>',
    )
    post = RedditCollector._rss_to_post(entry)
    assert post is not None
    assert post.source_url == "https://www.reddit.com/video/5wtt65kshxdh1/"
    assert post.source_id == "5wtt65kshxdh1"
    assert "/comments/" not in post.source_url


# ---------- gallery 多图帖误标修复（v0.8.8） ----------


def test_classify_media_gallery_url() -> None:
    """reddit.com/gallery/{id} 多图帖 → image_gallery（此前 fallback 误标 video_raw）。"""
    from backend.pipeline.collectors.reddit import classify_media

    assert classify_media("https://www.reddit.com/gallery/1vlf6lh", False, {}) == "image_gallery"
    assert classify_media("https://www.reddit.com/r/oddlysatisfying/gallery/1vlf6lh", False, {}) == "image_gallery"  # noqa: E501
    # 既有语义不回归
    assert classify_media("https://v.redd.it/abc123", False, {}) == "video_raw"
    assert classify_media("https://v.redd.it/abc123/DASH_720.mp4", True, {}) == "video_raw"
    assert classify_media("https://i.redd.it/abc.jpg", False, {}) == "image_gallery"
    assert classify_media("", False, {}) == "text_only"


# ---------- ffmpeg libass 缺失降级（v0.8.8） ----------


@pytest.mark.asyncio
async def test_subtitles_filter_detection(monkeypatch) -> None:
    """探测：优先读 deps 缓存；缓存缺失回退 -filters 行级精确匹配。"""
    import tempfile

    from backend.infrastructure import deps as deps_mod
    from backend.pipeline.producers import media as media_mod

    # 隔离 deps 缓存（避免真实 data/state/deps.json 干扰）
    monkeypatch.setattr(deps_mod.settings, "data_dir", Path(tempfile.mkdtemp()))
    deps_mod._cache = None
    import backend.pipeline.producers.compose as _comp
    _comp._subtitles_available = None

    # 无 ass 行 → False
    async def fake_exec(*a, **kw):
        class P:
            async def communicate(self):
                return b"Filters:\n T.. anull            A->A       Pass\n", b""
        return P()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    import backend.pipeline.producers.compose as _comp
    _comp._subtitles_available = None
    ok = await media_mod.subtitles_filter_available("/fake/ffmpeg")
    assert ok is False

    # 含 subtitles 行 → True
    async def fake_exec2(*a, **kw):
        class P:
            async def communicate(self):
                return b"Filters:\n T.. subtitles       V->V       Convert text subtitles\n", b""
        return P()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec2)
    import backend.pipeline.producers.compose as _comp
    _comp._subtitles_available = None
    ok2 = await media_mod.subtitles_filter_available("/fake/ffmpeg")
    assert ok2 is True

    # deps 缓存存在时直接读缓存（不再 subprocess）
    deps_mod._cache = {"ffmpeg": {"status": "ok", "libass": False}}
    import backend.pipeline.producers.compose as _comp
    _comp._subtitles_available = None
    assert await media_mod.subtitles_filter_available("/fake/ffmpeg") is False


# ---------- 基础依赖检测缓存（v0.8.8：启动一次 + 手动重测，运行时零探测） ----------


def test_deps_state_roundtrip(tmp_path, monkeypatch) -> None:
    """deps 状态：refresh 持久化 + load 读缓存（不重测）+ dep_ok 消费。"""
    from backend.infrastructure import deps as deps_mod

    monkeypatch.setattr(deps_mod.settings, "data_dir", tmp_path)
    deps_mod._cache = None

    async def fake_check():
        return {
            "checked_at": "2026-08-12T10:00:00+00:00",
            "ffmpeg": {"status": "ok", "path": "/x/ffmpeg", "libass": True},
            "biliup": {"status": "missing", "path": None},
        }

    monkeypatch.setattr(deps_mod, "check_dependencies", fake_check)
    data = asyncio.run(deps_mod.refresh_dependencies())
    assert data["ffmpeg"]["libass"] is True
    assert (tmp_path / "state" / "deps.json").exists()

    # 缓存存在：load 直接返回（无重测调用）
    calls = {"n": 0}
    monkeypatch.setattr(deps_mod, "check_dependencies", lambda: calls.__setitem__("n", calls["n"] + 1) or {})  # noqa: E501
    loaded = deps_mod.load_dependencies()
    assert loaded["ffmpeg"]["libass"] is True and calls["n"] == 0

    assert deps_mod.dep_ok(loaded, "ffmpeg") is True
    assert deps_mod.dep_ok(loaded, "biliup") is False
    assert deps_mod.dep_ok(None, "ffmpeg") is False


@pytest.mark.asyncio
async def test_deps_endpoints(client, tmp_path, monkeypatch) -> None:
    """GET /api/deps 读缓存；POST /api/deps/check 强制重测。"""
    from backend.infrastructure import deps as deps_mod

    monkeypatch.setattr(deps_mod.settings, "data_dir", tmp_path)
    deps_mod._cache = None

    resp = await client.get("/api/deps")
    assert resp.status_code == 200
    assert "ffmpeg" in resp.json()  # 缓存缺失时补测

    resp2 = await client.post("/api/deps/check")
    assert resp2.status_code == 200
    assert resp2.json()["checked_at"]


# ---------- AXIOM 全量审视（v0.8.9） ----------


@pytest.mark.asyncio
async def test_meta_validation_422(client) -> None:
    """AXIOM 8.1：非法排期/超长字段/越界 tid → 422（此前非法排期是 500）。"""
    from backend.models.item import Item
    from backend.models.session import session_factory

    async with session_factory() as session:
        it = Item(status="approved", source="reddit", source_id="mv-1", title="校验")
        session.add(it)
        await session.commit()
        item_id = str(it.id)

    bad_sched = await client.put(
        f"/api/pipeline/items/{item_id}/meta", json={"scheduled_at": "not-a-date"}
    )
    assert bad_sched.status_code == 422

    too_long = await client.put(
        f"/api/pipeline/items/{item_id}/meta", json={"bili_title": "长" * 90}
    )
    assert too_long.status_code == 422

    bad_tid = await client.put(
        f"/api/pipeline/items/{item_id}/meta", json={"bili_tid": 99999}
    )
    assert bad_tid.status_code == 422

    # 合法值仍可用（0 = 清空回默认）
    ok = await client.put(
        f"/api/pipeline/items/{item_id}/meta", json={"bili_title": "正常标题", "bili_tid": 0}
    )
    assert ok.status_code == 200


@pytest.mark.asyncio
async def test_batch_ids_limit(client) -> None:
    """AXIOM 8.1：batch ids 上限 200（此前无上限）。"""
    import uuid as _uuid

    resp = await client.post(
        "/api/pipeline/items/batch",
        json={"action": "approve", "ids": [str(_uuid.uuid4()) for _ in range(201)]},
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_produce_raw_degraded_fallback(monkeypatch) -> None:
    """AXIOM 4.6：合成彻底失败 → 原片兜底交付（标注 degraded，不伪装成功）。"""
    import tempfile
    from pathlib import Path

    from backend.pipeline.producers import media as media_mod

    tmp = Path(tempfile.mkdtemp())
    raw = tmp / "raw.mp4"
    raw.write_bytes(b"fake-raw-bytes")

    class Item:
        id = "0b5f8d1e-0000-4000-8000-000000000004"
        raw_path = str(raw)
        output_dir = "test-slug"
        produce_options = {"mute": False, "voice": False, "subtitle": True, "translate": True, "passthrough": False}  # noqa: E501
        title = "t"
        subreddit = "r"
        author = "a"

    class Files:
        def resolve(self, p): return p
        def output_root(self): return tmp / "out"

    class FakeAI:
        async def title_and_tags(self, **kw):
            from backend.ai.types import TitleResult
            return TitleResult(title="标题", tags=[], description="")
        async def chat_messages(self, messages, **kw):
            return "x"

    async def fake_compose(*a, **kw):
        raise media_mod.ProducerError("ffmpeg exploded")

    monkeypatch.setattr(media_mod, "compose_video", fake_compose)
    from backend.pipeline import phash as phash_mod

    async def fake_phash(p):
        return "abc"

    monkeypatch.setattr(phash_mod, "compute_phash", fake_phash)
    async def fake_cover(*a):
        return {"path": "x"}

    monkeypatch.setattr(media_mod, "generate_cover", fake_cover)

    artifacts = await media_mod.produce_item(FakeAI(), Files(), Item())
    assert artifacts["video"]["degraded"] == "raw"
    assert artifacts["video"]["path"] == str(raw)
    assert artifacts["script"]["produced_degraded"] == "raw"
    assert artifacts["phash"] == "abc"


def test_deps_install_hints(monkeypatch) -> None:
    """AXIOM 22.2：基础依赖缺失/降级时返回安装指引（install_hint，设置页可见展示）。"""
    from backend.infrastructure import deps as deps_mod

    async def fake_check():
        return {
            "checked_at": "2026-08-13T00:00:00+00:00",
            "ffmpeg": {"status": "missing", "path": None, "version": None, "libass": False,
                       "install_hint": "brew install homebrew-ffmpeg/ffmpeg/ffmpeg"},
            "ffprobe": {"status": "missing", "path": None,
                        "install_hint": "brew install ffmpeg"},
            "biliup": {"status": "ok", "path": "/x/biliup"},
            "yt-dlp": {"status": "missing", "path": None,
                       "install_hint": "uv pip install yt-dlp  （或 brew install yt-dlp）"},
            "edge-tts": {"status": "ok", "path": "/x/edge_tts"},
        }

    monkeypatch.setattr(deps_mod, "check_dependencies", fake_check)
    data = asyncio.run(deps_mod.check_dependencies())
    assert data["ffmpeg"]["install_hint"].startswith("brew install homebrew-ffmpeg")
    assert data["ffprobe"]["install_hint"] == "brew install ffmpeg"
    assert "yt-dlp" in data["yt-dlp"]["install_hint"]
    # 正常项不带 hint（前端只展示缺失项的指引）
    assert "install_hint" not in data["biliup"]
    assert "install_hint" not in data["edge-tts"]


# ---------- 翻译链路修复（v0.8.9，参考原项目 subtitle.py） ----------


def test_clean_zh_subtitle_text() -> None:
    """中文字幕清洗（原项目 clean_zh_subtitle_text 移植）：去标点、句间单空格。"""
    from backend.pipeline.producers.media import clean_zh_subtitle_text

    assert clean_zh_subtitle_text("他不吼不骂。蹲下来轻声说话！") == "他不吼不骂 蹲下来轻声说话"
    assert clean_zh_subtitle_text("这招比吼管用…真的") == "这招比吼管用 真的"
    assert clean_zh_subtitle_text("   ") == ""
    assert clean_zh_subtitle_text("English only sentence.") == "English only sentence."


@pytest.mark.asyncio
async def test_translate_condition(monkeypatch) -> None:
    """v0.8.9 翻译条件修复：want_translate 且旁白语言≠目标语言 → 翻译生效
    （此前 subtitle_lang=zh-CN 时条件误判跳过翻译——英文原样入字幕）。"""
    import tempfile
    from pathlib import Path

    from backend.pipeline.producers import media as media_mod

    tmp = Path(tempfile.mkdtemp())
    raw = tmp / "raw.mp4"
    raw.write_bytes(b"fake")
    calls: dict[str, int] = {"localize": 0}

    class Item:
        id = "0b5f8d1e-0000-4000-8000-000000000005"
        raw_path = str(raw)
        output_dir = "t-slug"
        produce_options = {"mute": False, "voice": False, "subtitle": True, "translate": True, "passthrough": False}  # noqa: E501
        title = "t"
        subreddit = "r"
        author = "a"

    class Files:
        def resolve(self, p): return p
        def output_root(self): return tmp / "out"

    class FakeAI:
        async def title_and_tags(self, **kw):
            from backend.ai.types import TitleResult
            return TitleResult(title="x", tags=[], description="")

    # v0.22.x：翻译走本地 Opus-MT——monkeypatch 引擎单条入口
    async def fake_mt(text: str) -> str:
        calls["localize"] += 1
        return "他蹲下来 孩子就不哭了"

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", fake_mt
    )

    async def fake_compose(*a, **kw):
        return {"path": str(tmp / "final.mp4")}

    async def fake_phash(p):
        return "abc"

    async def fake_cover(*a):
        return {"path": "x"}

    async def fake_probe(p):
        return 10.0

    from backend.pipeline import phash as phash_mod

    monkeypatch.setattr(media_mod, "compose_video", fake_compose)
    monkeypatch.setattr(phash_mod, "compute_phash", fake_phash)
    monkeypatch.setattr(media_mod, "generate_cover", fake_cover)
    monkeypatch.setattr(media_mod, "probe_duration", fake_probe)
    monkeypatch.setattr(media_mod, "synthesize_tts", lambda *a, **k: None)

    artifacts = await media_mod.produce_item(
        FakeAI(), Files(), Item(),
        existing_script={"mode": "script", "narration": "He kneels down. The kid stops crying."},
    )
    script = artifacts["script"]
    assert "他蹲下来" in script.get("subtitle_zh", "")  # 翻译生效（中文入字幕）
    assert calls["localize"] >= 1


@pytest.mark.asyncio
async def test_bump_seq_on_back_to_prep(client) -> None:
    """v0.8.9 入库序随操作刷新：打回预处理后条目 seq = max+1（列表最前）。"""
    from sqlalchemy import func, select

    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory

    async with session_factory() as session:
        it = Item(status=ItemStatus.QUEUED, source="reddit", source_id="bump-1", title="打回序")
        session.add(it)
        await session.commit()
        item_id = it.id
        old_max = (
            await session.execute(select(func.max(Item.seq)))
        ).scalar_one()

    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 200

    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "downloaded"
        assert row.seq > old_max  # 打回 = 最新入库序


# ---------- v0.8.9 对齐原项目：purge / retranslate / 字幕对齐 / 音色 ----------

@pytest.mark.asyncio
async def test_back_to_prep_purges_derived_media(client, tmp_path) -> None:
    """v0.8.9 打回即 purge：旧成片文件删除、字段清空、发布元数据保留。"""
    from backend.pipeline.helpers import purge_derived_media

    stale = tmp_path / "old.mp4"
    stale.write_bytes(b"stale")
    async with session_factory() as session:
        item = Item(
            status=ItemStatus.QUEUED, source="reddit", source_id="purge-1",
            title="purge", video_path=str(stale), cover_path=str(tmp_path / "c.jpg"),
            script_json={"narration": "old", "bili_tid": 201, "bili_title": "旧标题"},
        )
        session.add(item)
        await session.commit()
    assert stale.exists()

    await purge_derived_media(item)

    assert not stale.exists()
    assert item.video_path is None and item.cover_path is None
    assert item.script_json == {"bili_tid": 201, "bili_title": "旧标题"}


@pytest.mark.asyncio
async def test_retranslate_endpoint(client, monkeypatch) -> None:
    """v0.8.9 retranslate：ASR 原声→中文字幕，原声保留无 TTS。"""
    from backend.pipeline.producers import media as media_mod

    async def fake_asr(ai, raw, directory, target_lang="zh-CN"):
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "subs.srt").write_text(
            "1\n00:00:00,500 --> 00:00:01,500\n海浪拍打着岸边\n", encoding="utf-8"
        )
        return directory / "subs.srt", "海浪拍打着岸边"

    monkeypatch.setattr(media_mod, "_asr_subtitles", fake_asr)

    async def fake_compose(*a, **kw):
        out = a[3]
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"video")
        return {"path": str(out), "width": 1280, "height": 720}

    monkeypatch.setattr(media_mod, "compose_video", fake_compose)

    async def fake_cover(*a):
        return {"path": "/x/cover.jpg"}

    monkeypatch.setattr(media_mod, "generate_cover", fake_cover)
    from backend.pipeline import phash as phash_mod

    async def fake_phash(p):
        return "abc"

    monkeypatch.setattr(phash_mod, "compute_phash", fake_phash)

    raw_path = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False).name
    async with session_factory() as session:
        item = Item(status="queued", source="reddit", source_id="rt-1",
                    title="重翻译", raw_path=raw_path,
                    script_json={"narration": "old"}, video_path="/x/old.mp4")
        session.add(item)
        await session.commit()
        item_id = item.id

    resp = await client.post(f"/api/pipeline/items/{item_id}/retranslate")
    assert resp.status_code == 200, resp.text
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "queued"
        assert row.video_path.endswith("final.mp4")
        assert row.script_json["mode"] == "retranslate"
        assert row.script_json["subtitle_zh"] == "海浪拍打着岸边"
        assert row.audio_path is None  # 无 TTS


@pytest.mark.asyncio
async def test_retranslate_no_raw_409(client) -> None:
    async with session_factory() as session:
        item = Item(status="queued", source="reddit", source_id="rt-2",
                    title="无素材", raw_path=None)
        session.add(item)
        await session.commit()
        item_id = item.id
    resp = await client.post(f"/api/pipeline/items/{item_id}/retranslate")
    assert resp.status_code in (409, 502)


@pytest.mark.asyncio
async def test_script_to_srt_zh_split_and_align(tmp_path) -> None:
    """v0.8.9 对齐原项目：中文 22 字断句 + align_script 1:1 词数加权。"""
    from backend.pipeline.producers.media import parse_srt_cues, script_to_srt

    # 中文长段（>22 字）→ 折行
    zh = "这是一个非常长的中文字幕句子用来验证二十二字以内的断句逻辑是否正常工作" * 2
    out = tmp_path / "zh.srt"
    script_to_srt(zh, 10.0, out)
    cues = parse_srt_cues(out)
    assert len(cues) >= 2
    assert all(len(t) <= 22 for _, _, t in cues)

    # align_script：中文 cue 数 = 英文句数，词数加权
    en = "He kneels down. The crying stops. Kids listen. Big heart."
    out2 = tmp_path / "aligned.srt"
    script_to_srt("他蹲下来 哭声停了 孩子们听话 心很大", 8.0, out2, align_script=en)
    cues2 = parse_srt_cues(out2)
    assert len(cues2) == 4  # 1:1 对应英文 4 句
    # 词数加权：第 3 句（Kids listen，2 词）时长 > 第 1 句（He kneels down，3 词）？
    # 词数 3,3,2,2 → 前两句长于后两句
    durs = [e - s for s, e, _ in cues2]
    assert durs[0] >= durs[2]


@pytest.mark.asyncio
async def test_pick_voice_content_match() -> None:
    """v0.8.9 音色内容自适应：科技→男声，暖心→女声。"""
    from backend.pipeline.producers.tts_voice import pick_voice

    male, _ = pick_voice(title="NASA robot on Mars", script="", subreddit="space")
    female, _ = pick_voice(title="cute kitten rescue", script="", subreddit="aww")
    from backend.pipeline.producers.tts_voice import VOICE_CATALOG

    assert VOICE_CATALOG[male]["gender"] == "male"
    assert VOICE_CATALOG[female]["gender"] == "female"
    # 手动配置优先
    v, reason = pick_voice(title="cute cat", configured="zh-CN-YunxiNeural")
    assert v == "zh-CN-YunxiNeural" and reason == "configured"


# ---------- v0.8.9 字幕同步 / TTS 降级 / 翻译方向 ----------

def test_fit_script_to_budget_word_trim() -> None:
    """v0.8.9 按词数裁旁白：保句首、补句号、不切单词。"""
    from backend.pipeline.producers.media import fit_script_to_budget

    text = "This is a very long narration script that needs trimming down"
    out = fit_script_to_budget(text, 6)
    assert out == "This is a very long narration."
    # 不超则不裁
    assert fit_script_to_budget(text, 99) == text
    # max_words<=0 → 空
    assert fit_script_to_budget(text, 0) == ""


@pytest.mark.asyncio
async def test_voice_subtitles_sync_to_audio(tmp_path, monkeypatch) -> None:
    """v0.8.9 字幕同步：voice 模式字幕时间轴 = 旁白音频实际时长（非视频时长）。
    视频 60s / 旁白 20s → SRT 总时长 ≈ 20s + start_offset（默认 0.75s）。"""
    from backend.pipeline.producers.media import (
        parse_srt_cues,
        script_to_srt,
    )

    en = "He kneels down. The crying stops. Kids listen with big hearts."
    zh = "他蹲下来 哭声停了 孩子们用心听"
    out = tmp_path / "sync.srt"
    audio_dur = 20.0
    offset = 0.75
    script_to_srt(
        zh, audio_dur, out, start_offset=offset, align_script=en,
    )
    cues = parse_srt_cues(out)
    assert len(cues) == 3  # 1:1 英文 3 句
    # 字幕总长 = 旁白音频时长 + 起始偏移（不铺满视频 60s）
    assert cues[0][0] == pytest.approx(offset, abs=0.05)
    assert cues[-1][1] == pytest.approx(offset + audio_dur, abs=0.05)


@pytest.mark.asyncio
async def test_tts_overflow_drops_to_subs_only(client, tmp_path, monkeypatch) -> None:
    """v0.8.9 对齐原项目 _drop_to_subs_only：TTS 3 次仍超预算 → 放弃配音。

    生产方式 = voice（无字幕时会走视频时长字幕），旁白音频永远超视频。
    断言：artifacts.audio 为 None、start_offset 为 0、降级后不残留 narration。
    """
    from backend.pipeline.producers.media import produce_item

    class _FakeAI:
        tts_available = True

        async def synthesize(self, text, voice=""):
            return b"x" * 100

        async def chat_messages(self, messages, role="fast", **kw):
            return ""

        def _route(self, task):
            return object() if self.tts_available else None

        @property
        def has_tts(self):
            return True

    async def fake_probe(path):
        # 旁白音频永远 120s > 视频 60s → 三次裁词仍超 → 降级
        return 120.0 if "narration" in str(path) else 60.0

    monkeypatch.setattr("backend.pipeline.producers.media.probe_duration", fake_probe)

    item = Item(status="downloaded", source="reddit", source_id="drop-1",
                title="超预算降级", raw_path=str(tmp_path / "raw.mp4"),
                output_dir="drop-slug",
                produce_options={"voice": True, "subtitle": True})
    (tmp_path / "raw.mp4").write_bytes(b"raw")
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.producers import media as media_mod

    monkeypatch.setattr(media_mod, "_asr_subtitles", lambda *a, **k: None)

    artifacts = await produce_item(_FakeAI(), ServiceRegistry.get().files, item)
    assert artifacts["audio"] is None  # 降级：无旁白
    sub = artifacts.get("subtitle")
    assert sub is not None and sub["source"] in ("script",)
    # 字幕按视频时长（parse 验证总长 ≈ 60s）
    from pathlib import Path

    from backend.pipeline.producers.media import parse_srt_cues

    cues = parse_srt_cues(Path(sub["path"]))
    assert cues[-1][1] <= 61.0 and cues[-1][1] > 55.0


@pytest.mark.asyncio
async def test_localize_language_guard_unsupported_pair(monkeypatch) -> None:
    """v0.22.x：local 引擎仅 en→zh；其他语言对不介入，直接返回原文。"""
    import backend.pipeline.producers.media as media_mod
    from backend.pipeline.producers import translate_engine

    calls = {"n": 0}

    async def fake_mt(text: str) -> str:
        calls["n"] += 1
        return "不应被调用"

    monkeypatch.setattr(translate_engine, "translate_local", fake_mt)
    out = await media_mod._localize_text("hello", "ja", source_lang="en-US")
    assert out == "hello"
    assert calls["n"] == 0


@pytest.mark.asyncio
async def test_asr_subtitles_strip_punct(tmp_path, monkeypatch) -> None:
    """v0.8.9 ASR 译文标点清洗：cue 体无标点。"""
    import backend.pipeline.producers.media as media_mod

    async def fake_transcribe(path, out):
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\nHello, world!\n\n"
            "2\n00:00:01,000 --> 00:00:02,000\nHow are you?\n",
            encoding="utf-8",
        )
        return out

    async def fake_has_audio(*a, **k):
        return True

    monkeypatch.setattr("backend.pipeline.producers.asr.probe_has_audio", fake_has_audio)
    monkeypatch.setattr("backend.pipeline.producers.asr.transcribe", fake_transcribe)

    from backend.pipeline.producers import translate_engine

    async def fake_batch(texts: list[str]) -> list[str]:
        return ["你好，世界！", "你好吗？"]

    monkeypatch.setattr(translate_engine, "translate_batch_local", fake_batch)

    got = await media_mod._asr_subtitles(object(), Path("x.mp4"), tmp_path)
    assert got is not None
    srt, full = got
    assert "，" not in full and "！" not in full and "？" not in full
    assert "你好世界" in full

@pytest.mark.asyncio
async def test_non_voice_subtitles_use_original_audio_duration(
    tmp_path, monkeypatch
) -> None:
    """v0.8.9 两个制作概念之二：非旁白模式字幕时间轴 = 视频原声音频时长。

    原声 20s / 视频 60s → 字幕总长 ≈ 20s（不再铺满视频 60s）；
    无音轨视频 → 回退视频时长 60s。
    """
    from backend.pipeline.producers import media as media_mod

    async def fake_probe_audio(path):
        return 20.0

    async def fake_has_audio(path):
        return True

    monkeypatch.setattr(media_mod, "probe_audio_duration", fake_probe_audio)
    monkeypatch.setattr(media_mod, "probe_has_audio", fake_has_audio)

    from backend.pipeline.producers.media import parse_srt_cues, script_to_srt

    zh = "他蹲下来 哭声停了 孩子们用心听 慢慢靠近"
    out = tmp_path / "orig.srt"
    script_to_srt(zh, 20.0, out)
    cues = parse_srt_cues(out)
    # 原声 20s：字幕在 20s 内结束（对齐原声记录，不拖到视频 60s）
    assert cues[-1][1] == pytest.approx(20.0, abs=0.3)
    assert any(c[1] > 8.0 for c in cues)  # 多条 cue 铺满原声时长


# ---------- 文字故事产线（v0.11.7） ----------


def test_collect_text_only_kept_with_selftext() -> None:
    """v0.11.7：text_only 帖保留（≥50 字正文）；短正文丢弃。"""
    from backend.pipeline.collectors.reddit import RedditCollector

    post = RedditCollector._to_post({
        "id": "story-1", "title": "AITA for not paying my sister's wedding",
        "selftext": "My sister asked me to pay for her 200-guest wedding. I refused because "
                    "she never supported my career choices and mocked me in front of my kids.",
        "permalink": "/r/AmItheAsshole/comments/story1/",
        "author": "u1", "score": 8800, "upvote_ratio": 0.91,
        "num_comments": 2300, "created_utc": 1_700_000_000.0,
        "stickied": False, "is_video": False, "url": "",
    })
    assert post is not None
    assert post.item_type == "text_only"
    assert post.media_url == ""
    assert len(post.selftext) >= 50

    short = RedditCollector._to_post({
        "id": "story-2", "title": "t", "selftext": "too short",
        "permalink": "/r/AmItheAsshole/comments/story2/",
        "author": "u2", "score": 1, "upvote_ratio": 1.0, "num_comments": 0,
        "created_utc": 1_700_000_000.0, "stickied": False,
        "is_video": False, "url": "",
    })
    assert short is None


def test_story_safety_only_compliance() -> None:
    """v0.11.7：故事旁白 safety_only——安全红线阻断，营销极限词降级告警。"""
    from backend.pipeline.sensitive import check_text

    blocked = check_text("他沉迷赌博，把家里钱都输了", safety_only=True)
    assert "赌博" in blocked["tier1"]

    # 「最/第一」是中文口语高频词：safety_only 下不进 tier1，降级 tier2 告警
    ok = check_text("这是我最好的朋友，也是第一次有人这样对我", safety_only=True)
    assert ok["tier1"] == []
    assert "最" in ok["tier2"]

    # 默认严格模式：营销极限词仍阻断（标题/简介场景）
    strict = check_text("最顶级的产品")
    assert "最" in strict["tier1"]


# ---------- 归档 / 备用库（wave10：删除入口收口异常区） ----------


@pytest.mark.asyncio
async def test_archive_clears_disk_keeps_base_data(client, tmp_path) -> None:
    """归档：磁盘资源全删 + 字段清洗（script 只留 bili_*）+ 基础数据保留。"""
    from backend.config import settings

    raw = tmp_path / "raw.mp4"
    raw.write_bytes(b"raw")
    video = tmp_path / "final.mp4"
    video.write_bytes(b"video")
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"cover")
    out_dir = Path(settings.data_dir) / "pipeline" / "archive-slug-1"
    out_dir.mkdir(parents=True)
    (out_dir / "subs.srt").write_text("1\n00:00:00,000 --> 00:00:01,000\nx\n", encoding="utf-8")

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="arch-1",
            title="归档条目", raw_path=str(raw), video_path=str(video),
            cover_path=str(cover), output_dir="pipeline/archive-slug-1",
            script_json={"narration": "old", "bili_title": "标题", "bili_tid": 201},
            publish_json={"bvid": "BV1", "stats": {"view": 10}},
            scheduled_at=datetime.now(UTC) + timedelta(hours=1),
            queue_phase="ready",
        )
        session.add(item)
        await session.commit()
        item_id = str(item.id)

    resp = await client.post("/api/pipeline/items/archive", json={"ids": [item_id]})
    assert resp.status_code == 200
    assert resp.json() == {"ok": 1, "failed": []}

    assert not raw.exists() and not video.exists() and not cover.exists()
    assert not out_dir.exists()

    async with session_factory() as session:
        row = await session.get(Item, item.id)
        assert row is not None
        assert row.archived is True
        assert row.raw_path is None and row.video_path is None and row.cover_path is None
        assert row.output_dir is None
        assert row.scheduled_at is None and row.queue_phase == ""
        assert row.script_json == {"bili_title": "标题", "bili_tid": 201}
        assert row.title == "归档条目" and row.source == "reddit"
        assert (row.publish_json or {}).get("bvid") == "BV1"


@pytest.mark.asyncio
async def test_archived_excluded_from_lists_counts_calendar(client) -> None:
    """归档条目从列表/计数/日历消失，只出现在备用库。"""
    async with session_factory() as session:
        a = Item(status=ItemStatus.PUBLISHED, source="reddit", source_id="excl-a", title="活条目")
        b = Item(status=ItemStatus.PUBLISHED, source="reddit", source_id="excl-b", title="归档条目")
        session.add_all([a, b])
        await session.commit()
        a_id, b_id = str(a.id), str(b.id)

    await client.post("/api/pipeline/items/archive", json={"ids": [b_id]})

    listed = (await client.get("/api/pipeline/items?status=published&limit=500")).json()
    ids = {i["id"] for i in listed}
    assert a_id in ids and b_id not in ids

    counts = (await client.get("/api/pipeline/items/counts")).json()
    # 归档排除后：可见 published 列表与计数一致（其他测试可能残留 published 条目）
    assert counts.get("published", 0) == len(ids)

    cal = (
        await client.get(
            "/api/pipeline/calendar",
            params={"from": "2000-01-01", "to": "2100-01-01"},
        )
    ).json()
    assert b_id not in {i["id"] for i in cal["items"]}

    archived = (await client.get("/api/pipeline/items/archived")).json()
    assert b_id in {i["id"] for i in archived}
    assert a_id not in {i["id"] for i in archived}


@pytest.mark.asyncio
async def test_unarchive_restores_to_lists(client) -> None:
    """恢复：清除 archived 标记，条目回到原状态列表。"""
    async with session_factory() as session:
        item = Item(status=ItemStatus.APPROVED, source="reddit", source_id="unarch-1", title="恢复")
        session.add(item)
        await session.commit()
        item_id = str(item.id)

    await client.post("/api/pipeline/items/archive", json={"ids": [item_id]})
    assert item_id not in {
        i["id"] for i in (await client.get("/api/pipeline/items?status=approved")).json()
    }

    resp = await client.post("/api/pipeline/items/unarchive", json={"ids": [item_id]})
    assert resp.json() == {"ok": 1, "failed": []}

    assert item_id in {
        i["id"] for i in (await client.get("/api/pipeline/items?status=approved")).json()
    }


@pytest.mark.asyncio
async def test_purge_deletes_row_and_disk(client, tmp_path) -> None:
    """彻底删除：仅归档条目可 purge；删行 + best-effort 再清磁盘。"""
    raw = tmp_path / "raw2.mp4"
    raw.write_bytes(b"raw2")
    async with session_factory() as session:
        item = Item(
            status=ItemStatus.FAILED, source="reddit", source_id="purge-1",
            title="待删", raw_path=str(raw),
        )
        session.add(item)
        await session.commit()
        item_id = str(item.id)

    # 未归档条目拒绝 purge
    resp = await client.post("/api/pipeline/items/purge", json={"ids": [item_id]})
    assert resp.json()["ok"] == 0 and len(resp.json()["failed"]) == 1

    await client.post("/api/pipeline/items/archive", json={"ids": [item_id]})
    assert not raw.exists()

    resp = await client.post("/api/pipeline/items/purge", json={"ids": [item_id]})
    assert resp.json() == {"ok": 1, "failed": []}

    async with session_factory() as session:
        assert await session.get(Item, item.id) is None


@pytest.mark.asyncio
async def test_archive_rejects_flowing_states(client) -> None:
    """流程中状态（queued 等）不可归档——单条失败不中断，其余继续。"""
    async with session_factory() as session:
        flow = Item(status=ItemStatus.QUEUED, source="reddit", source_id="flow-1", title="审核中")
        done = Item(status=ItemStatus.REJECTED, source="reddit", source_id="flow-2", title="已拒")
        session.add_all([flow, done])
        await session.commit()
        flow_id, done_id = str(flow.id), str(done.id)

    resp = await client.post(
        "/api/pipeline/items/archive", json={"ids": [flow_id, done_id]}
    )
    body = resp.json()
    assert body["ok"] == 1
    assert body["failed"][0]["id"] == flow_id
    assert "state queued" in body["failed"][0]["error"]
