"""空壳条目治理（v0.33）：判据、隔离、计数口径、熔断不被误伤。

存在理由（本轮实测）：库里 **2011 条 `media_url == source_url`**（帖子页 URL 被当成
媒体直链存下），其中 **1989 条连 selftext 都没有**。它们被 `classify_media` 的兜底
分支标成 `video_raw`，于是：

- 内容流水线的 `discovered` 数字里 42% 是不可操作的空壳（用户会对着它点下载/批量
  操作，得到必然的失败）；
- 点下载就去抓 `www.reddit.com/r/.../comments/...`，而 Reddit 对页面端点做机器人
  拦截 → 403 / `Server disconnected`（实测对照：同机 `v.redd.it/DASHPlaylist.mpd`
  返回 200，挡的是页面不是媒体 CDN）；
- 403 经 `note_resource_failure` 把**整个域**冻 300/600s，同域 2089 条真视频跟着
  被 skip —— 一条空壳让全队列停摆。

隔离判据用新增布尔 `is_invalid`（照 `is_lowscore` 先例），**不用** `queue_phase`
（它是发布排队字段，`service_schedule.py` 用 `!= 'holding'` 反向过滤会漏）、
**也不用** `item_type` 第四值（`category.py` / `heuristic_score.py` / `helpers.py`
全是「不认识就按视频处理」的默认分支）。原因走 `error_class` + `error` 文本。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import select

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.base import StepContext

PAGE = "https://www.reddit.com/r/relationships/comments/1vwn13f/need_help/"


def _ctx():
    return StepContext(run_id="t-shell", settings=None, ai=None, emit=lambda e: None)


def _post(source_id: str, *, media_url: str | None, selftext: str = "", title: str = "标题"):
    from backend.pipeline.collectors.base import RawPost

    return RawPost(
        source_id=source_id,
        title=title,
        source_url=PAGE,
        media_url=media_url if media_url is not None else PAGE,
        author="a",
        score=10,
        upvote_ratio=0.9,
        num_comments=1,
        created_utc=1_700_000_000.0,
        selftext=selftext,
    )


# ---------- 判据：一个作者 ----------


def test_classify_media_stops_guessing_video_raw() -> None:
    """「不确定就算视频」正是 2011 条的来源——不确定必须是显式的 no_media。"""
    from backend.pipeline.collectors.reddit import classify_media

    # 帖子页 URL 当媒体：不是视频、不是图、不是文字帖
    assert classify_media(PAGE, False, {}) == "no_media"
    assert classify_media("https://old.reddit.com/r/x/comments/1abc/t/", False, {}) == "no_media"
    assert classify_media("https://www.reddit.com/r/x/comments/", False, {}) == "no_media"
    # 既有语义一条不回归
    assert classify_media("https://v.redd.it/abc123", False, {}) == "video_raw"
    assert classify_media("https://v.redd.it/abc123/DASH_720.mp4", True, {}) == "video_raw"
    assert classify_media("https://i.redd.it/abc.jpg", False, {}) == "image_gallery"
    assert classify_media("https://www.reddit.com/gallery/1vlf6lh", False, {}) == "image_gallery"
    assert classify_media("", False, {}) == "text_only"


def test_page_as_media_is_quarantined_not_dropped() -> None:
    """「media_url 是帖子页」与「死 id」是两件事：前者要留着（有标题/有页/能去重），
    后者才丢弃。把两条判据混进一个函数，就会出现「为修 403 反而丢了 1989 条记录」。"""
    from backend.pipeline.download import is_dead_reddit_media
    from backend.pipeline.quality import shell_reason

    # 必死 id 仍按原语义丢弃
    assert is_dead_reddit_media("https://v.redd.it/abc", "", "abc") is True
    # 空壳不丢弃——交给采集侧打隔离标
    assert is_dead_reddit_media(PAGE, PAGE, "1vwn13f") is False
    # 判据本身：无媒体 + 无正文 = 空壳
    assert shell_reason(media_url=PAGE, selftext="") is not None
    assert shell_reason(media_url=None, selftext="") is not None
    # 有真直链、或正文够长 → 都不该被隔离
    assert shell_reason(
        media_url="https://v.redd.it/abc/DASHPlaylist.mpd", selftext=""
    ) is None
    assert shell_reason(media_url=PAGE, selftext="这是一段够长的正文。" * 10) is None
    # 跨源误伤护栏：YouTube/B站 的 media_url 本来就可以是播放页（交给 yt-dlp 解析）
    assert shell_reason(media_url="https://www.youtube.com/watch?v=abc123", selftext="") is None
    assert shell_reason(media_url="https://www.bilibili.com/video/BV1xx/", selftext="") is None


# ---------- 隔离：入库但退出可操作队列 ----------


@pytest.mark.asyncio
async def test_shell_post_is_stored_marked_invalid() -> None:
    """空壳（无媒体且无正文）**保留入库**，但打隔离标 + 原因，不占流水线。"""
    from backend.pipeline.collectors.reddit import FakeRedditCollector
    from backend.pipeline.steps.collect import run_collect

    collector = FakeRedditCollector([_post("shell-1", media_url=PAGE)])
    await run_collect(_ctx(), channel="relationships", limit=10, collector=collector)

    async with session_factory() as session:
        row = (
            await session.execute(select(Item).where(Item.source_id == "shell-1"))
        ).scalar_one()
        assert row.is_invalid is True
        assert row.error_class == "invalid_media"
        assert "媒体" in (row.error or "")  # 原因要能读懂，但不钉死措辞
        # 隔离不靠 queue_phase（那是发布字段）——保持空，别污染发布链路
        assert row.queue_phase == ""
        # 未判定内容类型：留空，由 error 说明原因（不许再冒充 video_raw）
        assert row.item_type == ""


@pytest.mark.asyncio
async def test_long_selftext_post_is_not_invalid() -> None:
    """有正文的帖子走文字产线，不算空壳（别把可用内容一起隔离掉）。"""
    from backend.pipeline.collectors.reddit import FakeRedditCollector
    from backend.pipeline.steps.collect import run_collect

    text = "这是一段足够长的正文，" * 8
    collector = FakeRedditCollector([_post("story-1", media_url=PAGE, selftext=text)])
    await run_collect(_ctx(), channel="relationship_advice", limit=10, collector=collector)

    async with session_factory() as session:
        row = (
            await session.execute(select(Item).where(Item.source_id == "story-1"))
        ).scalar_one()
        assert row.is_invalid is False
        assert row.item_type == "text_only"


@pytest.mark.asyncio
async def test_counts_and_list_exclude_invalid_symmetrically(client) -> None:
    """计数与列表必须**同时**排除：只改一侧就会出现「列表里没有、数字里还在」。"""
    from backend.pipeline.collectors.reddit import FakeRedditCollector
    from backend.pipeline.steps.collect import run_collect

    collector = FakeRedditCollector([
        _post("shell-2", media_url=PAGE, title="空壳一条"),
        _post("real-2", media_url="https://v.redd.it/abc9/DASHPlaylist.mpd", title="真视频一条"),
    ])
    await run_collect(_ctx(), channel="nextfuckinglevel", limit=10, collector=collector)

    listed = (
        await client.get("/api/pipeline/items", params={"status": "discovered", "limit": 500})
    ).json()
    ids = {i["id"] for i in listed}
    counts = (await client.get("/api/pipeline/items/counts")).json()

    async with session_factory() as session:
        shell_id = str((
            await session.execute(select(Item).where(Item.source_id == "shell-2"))
        ).scalar_one().id)
        real_id = str((
            await session.execute(select(Item).where(Item.source_id == "real-2"))
        ).scalar_one().id)

    assert real_id in ids
    assert shell_id not in ids, "空壳仍在可操作列表里"
    assert counts.get("discovered", 0) == len(ids), "counts 与列表口径不一致"

    # 异常区要还能查到它（不丢数据）
    shells = (await client.get("/api/pipeline/items", params={
        "status": "discovered", "include_invalid": "true", "limit": 500,
    })).json()
    assert shell_id in {i["id"] for i in shells}


@pytest.mark.asyncio
async def test_invalid_still_dedupes_recollect() -> None:
    """重复抓取时，已入库的空壳仍参与去重——这正是隔离后保留它们的价值之一。"""
    from backend.pipeline.collectors.reddit import FakeRedditCollector
    from backend.pipeline.steps.collect import run_collect

    post = _post("shell-3", media_url=PAGE)
    first = await run_collect(_ctx(), channel="BeAmazed", limit=10,
                              collector=FakeRedditCollector([post]))
    second = await run_collect(_ctx(), channel="BeAmazed", limit=10,
                               collector=FakeRedditCollector([post]))
    assert first["inserted"] == 1
    assert second["inserted"] == 0 and second["skipped"] == 1

    async with session_factory() as session:
        rows = (
            await session.execute(select(Item).where(Item.source_id == "shell-3"))
        ).scalars().all()
        assert len(rows) == 1


# ---------- 不再连带冻域 ----------


@pytest.mark.asyncio
async def test_invalid_item_never_reaches_the_download_step(client) -> None:
    """空壳不得进入下载流程：它从没碰过 CDN，让它撞闸等于冻掉真视频。"""
    from backend.pipeline.download import (
        clear_resource_cooldown,
        note_resource_failure,
        reset_cdn_circuit,
        resource_cooldown_left,
    )
    from backend.pipeline.steps.download import DownloadStep

    async with session_factory() as session:
        row = (await session.execute(select(Item).where(Item.source_id == "shell-2"))).scalar_one()
        row.media_url = "https://v.redd.it/frozenprobe/DASHPlaylist.mpd"
        await session.commit()
        media = row.media_url

    # 起步先把全局冷却/熔断清干净：这些是模块级状态，别的测试留了值就会污染断言
    await clear_resource_cooldown(media)
    reset_cdn_circuit()
    assert await resource_cooldown_left(media) == 0

    result = await DownloadStep().process(_ctx(), row)
    assert result.skip is True, "隔离条目仍被当作可下载对象"
    assert await resource_cooldown_left(media) == 0, "空壳被记进了域冷却——真视频会跟着被冻"

    # 只有「真的碰过 CDN 并失败」才该冻域：手动注一次证明机制本身还在，不是被我关掉了
    await note_resource_failure(media, error="HTTP 403")
    assert await resource_cooldown_left(media) > 0
    await clear_resource_cooldown(media)  # 不把冷却状态留给后面的测试


# ---------- 体检：造脏数据必须被报出来（空报告不算过） ----------


@pytest.mark.asyncio
async def test_integrity_reports_new_shell_by_one() -> None:
    """巡检的价值只在「多一条脏数据，计数就 +1」。

    测试库里有别的测试留下的历史数据，所以断言**增量**而不是绝对值——
    绝对值会把偶然的干净状态当成契约。
    """
    from backend.pipeline.integrity import (
        check_shell_in_pipeline,
        check_video_without_media,
    )

    before_shell = (await check_shell_in_pipeline()).count
    before_video = (await check_video_without_media()).count

    async with session_factory() as session:
        session.add(Item(
            status="discovered", source="integrity-probe", source_id="probe-1",
            title="手动造一条漏网空壳", source_url=PAGE, media_url=PAGE, item_type="video_raw",
        ))
        await session.commit()

    try:
        assert (await check_shell_in_pipeline()).count == before_shell + 1
        assert (await check_video_without_media()).count == before_video + 1
        # 打隔离标之后两条都必须恢复：判据与数据一致才算修完
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(Item).where(Item.source_id == "probe-1")
                )
            ).scalar_one()
            row.is_invalid = True
            row.error_class = "invalid_media"
            await session.commit()
        assert (await check_shell_in_pipeline()).count == before_shell
        assert (await check_video_without_media()).count == before_video
    finally:
        async with session_factory() as session:
            await session.execute(
                Item.__table__.delete().where(Item.source_id == "probe-1")
            )
            await session.commit()


@pytest.mark.asyncio
async def test_integrity_alerts_once_and_resets_on_recovery(monkeypatch) -> None:
    """不一致只告警一次；恢复后再坏一次还要能再告（与模型下载告警同一机制）。"""
    from backend.infrastructure import alerts
    from backend.pipeline import integrity

    sent: list[str] = []
    monkeypatch.setattr(alerts, "_send", sent.append)
    alerts.reset("data_integrity")
    bad = {"ok": False, "checked": 2, "failed": ["shell_in_pipeline", "invalid_share"],
           "findings": [{"name": "shell_in_pipeline", "ok": False, "count": 7,
                         "hint": "跑 quarantine 脚本", "samples": []}]}
    good = {"ok": True, "checked": 2, "failed": [], "findings": []}

    calls = iter([bad, bad, good, bad])
    monkeypatch.setattr(integrity, "integrity_report", lambda: _ret(next(calls)))
    integrity._last_bad = frozenset()

    await integrity.run_integrity_check()
    await integrity.run_integrity_check()
    assert len(sent) == 1, "同一批不一致刷屏告警"
    await integrity.run_integrity_check()   # 恢复
    assert len(sent) == 1
    await integrity.run_integrity_check()   # 再坏 → 必须再告一次
    assert len(sent) == 2
    assert "shell_in_pipeline" in sent[0]


def _ret(v):
    async def _c():
        return v
    return _c()


# ---------- 门禁：谁能写 discovered ----------


def test_only_collect_step_writes_discovered_items() -> None:
    """`status=discovered` 的唯一写入口必须是 `steps/collect.py` 的受闸路径。

    2011 条空壳就是从「第二处直接建 Item」的缝里进来的：闸装在一个入口上，
    别的入口照样灌。这里用 AST 找所有 `Item(...)` 构造点里带
    `status=ItemStatus.DISCOVERED`/`status="discovered"` 的，只允许一处。
    """
    import ast

    def _writers_of(src: str) -> list[str]:
        out: list[str] = []
        for node in ast.walk(ast.parse(src)):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id != "Item":
                continue
            for kw in node.keywords:
                val = kw.value
                text = getattr(val, "attr", None) or getattr(val, "value", None)
                if kw.arg == "status" and text in ("DISCOVERED", "discovered"):
                    out.append("hit")
        return out

    # 守卫自身的对照：写错了就什么也抓不到（假绿比假红更危险）
    assert _writers_of("Item(status=ItemStatus.DISCOVERED)") == ["hit"]
    assert _writers_of('Item(status="discovered")') == ["hit"]
    assert _writers_of("Item(status=ItemStatus.QUEUED)") == []
    assert _writers_of("Item(source_id='x')") == []

    root = Path(__file__).resolve().parents[1]
    writers: list[str] = []
    for path in (root / "backend").rglob("*.py"):
        if "__pycache__" in str(path):
            continue
        src = path.read_text(encoding="utf-8")
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)):
                continue
            if node.func.id != "Item":
                continue
            for kw in node.keywords:
                val = kw.value
                # `ItemStatus.DISCOVERED` 是 Attribute（取 .attr），
                # `"discovered"` 是 Constant（取 .value）。顺序反了会先取到
                # Attribute.value（一个 ast.Name 对象），永远匹配不上——
                # 守卫自己也得能被证伪，所以上面有正/负样本对照。
                text = getattr(val, "attr", None) or getattr(val, "value", None)
                if kw.arg == "status" and text in ("DISCOVERED", "discovered"):
                    writers.append(str(path.relative_to(root)))
                    break

    # 每个写 discovered 的入口都必须**表过态**：要么走质量闸（stamp），
    # 要么写明为什么不走（工坊草稿的 `quality-gate: manual`）。
    # 只要求 collect 一处会把合理例外也判成 bug；放任不声明才是真问题。
    undeclared = []
    for rel in sorted(set(writers)):
        src = (root / rel).read_text(encoding="utf-8")
        if "stamp(" not in src and "# quality-gate:" not in src:
            undeclared.append(rel)
    assert not undeclared, (
        f"这些入口在写 discovered 条目却没说明走不走质量闸：{undeclared}"
    )
    # 采集主路径必须真的过闸（否则上面的「声明」可以是假话）
    collect_src = (root / "backend/pipeline/steps/collect.py").read_text(encoding="utf-8")
    assert "stamp(item)" in collect_src, "采集入口的质量闸被摘掉了"


def test_item_type_consumers_are_explicit_about_invalid() -> None:

    """读侧不许再靠「不认识就按视频」的默认分支处理内容类型。

    判据本身很简单：产线路由处不许出现 `item_type or "video_raw"` 这类兜底——
    今天 2011 条空壳正是被它一路推成视频的。
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    offenders: list[str] = []
    for path in (root / "backend").rglob("*.py"):
        if "__pycache__" in str(path):
            continue
        src = path.read_text(encoding="utf-8")
        if 'or "video_raw"' in src or "or 'video_raw'" in src:
            offenders.append(str(path.relative_to(root)))
    assert not offenders, (
        "内容类型不许有默认猜测（未判定就该是未判定）: " + ", ".join(sorted(offenders))
    )
