"""v0.2.9 下载韧性测试：候选链 / 请求头 / 死 id 预筛 / CDN 熔断 / 候选降级 / 静图防护。

候选降级走本地 HTTP 服务器（loopback 逃生阀），不触碰真实网络。
"""

import asyncio
import socket

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse

from backend.pipeline.download import (
    cdn_circuit_open,
    cdn_circuit_remaining,
    download_headers,
    is_dead_reddit_media,
    media_candidates,
    reset_cdn_circuit,
    trip_cdn_circuit,
)

# ---------- 候选链 ----------

def test_media_candidates_chain() -> None:
    """v.redd.it 视频 → DASH_720.mp4 变体 + 原 URL + permalink 兜底；
    清单候选（.mpd/.m3u8）排除——无解析器，直下会误存 XML 文本（§34 查漏补缺）。"""
    url = "https://v.redd.it/abc123/DASH_720.mp4"
    permalink = "https://www.reddit.com/r/funny/comments/abc123/title/"
    cands = media_candidates(url, permalink)
    assert cands[0] == url  # 已是 DASH_720.mp4：原样在前
    assert permalink in cands
    assert len(cands) == len(set(cands))  # 去重
    # 清单候选绝不出现
    assert not any(".mpd" in c or ".m3u8" in c for c in cands)

    # 裸 v.redd.it id → 只生成 DASH_720.mp4（无清单）
    raw_id = media_candidates("https://v.redd.it/abc123", permalink)
    assert "https://v.redd.it/abc123/DASH_720.mp4" in raw_id
    assert not any(".mpd" in c or ".m3u8" in c for c in raw_id)

    # 非 v.redd.it：只保留原 URL + permalink
    plain = media_candidates("https://i.redd.it/x.jpg", "https://www.reddit.com/r/a/comments/1/x/")
    assert plain[0] == "https://i.redd.it/x.jpg"
    assert len(plain) == 2


def test_looks_like_manifest() -> None:
    from backend.pipeline.download import looks_like_manifest

    assert looks_like_manifest(b'<?xml version="1.0" encoding="UTF-8"?><MPD>')
    assert looks_like_manifest(b"#EXTM3U\n#EXT-X-VERSION:3")
    assert not looks_like_manifest(b"\x00\x00\x00\x18ftypmp42")  # mp4 魔数
    assert not looks_like_manifest(b"\xff\xd8\xff\xe0")  # jpeg 魔数
    assert not looks_like_manifest(b"")


def test_media_candidates_filtered_by_checker() -> None:
    """checker 参数化：loopback 逃生（scheme-only）保留候选。"""
    url = "http://127.0.0.1:9999/a.mp4"
    assert media_candidates(url, None) == []  # 默认 SSRF 检查拒绝 loopback
    lax = lambda u: u.startswith(("http://", "https://"))  # noqa: E731
    assert media_candidates(url, None, checker=lax) == [url]


# ---------- 请求头 ----------

def test_download_headers_reddit_only() -> None:
    reddit = download_headers("https://v.redd.it/abc/DASH_720.mp4")
    assert reddit["Referer"] == "https://www.reddit.com/"
    assert "Origin" in reddit and "Sec-Fetch-Site" in reddit
    # 非 Reddit 域不附加（防泄漏）
    other = download_headers("https://www.bilibili.com/video/BV1xx")
    assert "Referer" not in other and "Origin" not in other
    # UA 始终有
    assert "User-Agent" in reddit and "User-Agent" in other


# ---------- 死 id 预筛 ----------

def test_is_dead_reddit_media() -> None:
    # v.redd.it 无 /comments/ 详情页 → 死
    assert is_dead_reddit_media(
        "https://v.redd.it/abc123", "https://www.reddit.com/r/x/abc123", "abc123"
    )
    # 有详情页 → 活
    assert not is_dead_reddit_media(
        "https://v.redd.it/abc123",
        "https://www.reddit.com/r/x/comments/abc123/title/",
        "abc123",
    )
    # 1f1 死 id 且无详情页 → 死
    assert is_dead_reddit_media("https://i.redd.it/x.jpg", "", "dead1f1")
    # 1f1 但有详情页 → 活
    assert not is_dead_reddit_media(
        "https://i.redd.it/x.jpg",
        "https://www.reddit.com/r/x/comments/dead1f1/t/",
        "dead1f1",
    )
    # 普通图片 → 活
    assert not is_dead_reddit_media("https://i.redd.it/x.jpg", "", "alive")


# ---------- CDN 熔断 ----------

def test_cdn_circuit_breaker(monkeypatch) -> None:
    from backend.pipeline import download as dl

    monkeypatch.setattr(dl.settings, "pipeline_cdn_circuit_403", 3)
    monkeypatch.setattr(dl.settings, "pipeline_cdn_circuit_cooldown", 600)
    dl._cdn_until = 0  # 清熔断时间（测试直接操纵模块状态）
    reset_cdn_circuit()
    assert not cdn_circuit_open()
    # 3 次 403 → 熔断
    assert trip_cdn_circuit() is False
    assert trip_cdn_circuit() is False
    assert trip_cdn_circuit() is True  # 刚触发
    assert cdn_circuit_open()
    assert cdn_circuit_remaining() > 0
    # 非 403 重置连续计数（熔断时间仍在——冷却期不因单次成功而解除）
    reset_cdn_circuit()
    assert dl._cdn_403_count == 0
    assert cdn_circuit_open()  # 熔断时间未到
    # 冷却结束后熔断解除
    dl._cdn_until = 0
    assert not cdn_circuit_open()
    # 测试隔离（§34）：恢复模块状态，避免污染后续测试的 403 计数
    dl._cdn_403_count = 0
    dl._cdn_until = 0


# ---------- 候选降级集成（本地服务器） ----------

def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _make_server(tmp_path) -> tuple[str, FastAPI]:
    ok = tmp_path / "present.mp4"
    ok.write_bytes(b"x" * 2048)
    app = FastAPI()

    @app.get("/present.mp4")
    async def present():
        return FileResponse(ok)

    @app.get("/missing.mp4")
    async def missing():
        from fastapi import Response

        return Response(status_code=404)

    return str(tmp_path), app


@pytest.mark.asyncio
async def test_download_step_candidate_fallback(tmp_path) -> None:
    """候选链降级：第一个候选 404 → 自动尝试下一个候选（permalink 兜底）→ 成功。"""
    import uvicorn

    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory
    from backend.pipeline.steps.download import DownloadStep

    _, app = _make_server(tmp_path)
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    serve_task = asyncio.create_task(server.serve())
    await asyncio.sleep(0.3)  # 等真实端口就绪

    try:
        async with session_factory() as session:
            item = Item(
                status=ItemStatus.DISCOVERED,
                source="reddit",
                source_id="dl-fallback",
                title="候选降级",
                media_url=f"http://127.0.0.1:{port}/missing.mp4",  # 404
                source_url=f"http://127.0.0.1:{port}/present.mp4",  # permalink 兜底 200
                item_type="video_raw",
            )
            session.add(item)
            await session.commit()
            item_id = item.id

        class SettingsStub:
            data_dir = tmp_path
            pipeline_allow_loopback_urls = True
            pipeline_download_delay_seconds = 0  # 测试不等待

        class Ctx:
            settings = SettingsStub()

            def log(self, message, level="info"):
                pass

        result = await DownloadStep().process(Ctx(), await _get_item(item_id))
        assert result.status == "downloaded"
        # output_dir 已持久化（process 内写 DB）——重新加载拿最新值
        row = await _get_item(item_id)
        raw = tmp_path / "pipeline" / row.output_dir.split("/")[-1] / "raw.mp4"
        assert raw.exists() and raw.stat().st_size == 2048
    finally:
        server.should_exit = True
        await serve_task
        # 测试隔离（AXIOM §34）：清理残留条目，避免污染后续 chain 测试
        async with session_factory() as session:
            row = await session.get(Item, item_id)
            if row is not None:
                await session.delete(row)
                await session.commit()


@pytest.mark.asyncio
async def test_download_still_guard(tmp_path) -> None:
    """静图防护：空文件（<256B）拒绝；正常大小成功。"""
    import uvicorn

    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory
    from backend.pipeline.steps.download import DownloadStep

    ok = tmp_path / "still.jpg"
    ok.write_bytes(b"x" * 4096)
    app = FastAPI()

    @app.get("/ok.jpg")
    async def ok_route():
        return FileResponse(ok)

    tiny_file = tmp_path / "tiny.jpg"
    tiny_file.write_bytes(b"x" * 100)  # 下载成功但 < 256B 最小阈值

    @app.get("/tiny.jpg")
    async def tiny_route():
        return FileResponse(tiny_file)  # 支持 Range：走到 size 校验分支

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    serve_task = asyncio.create_task(server.serve())
    await asyncio.sleep(0.3)

    try:
        class SettingsStub:
            data_dir = tmp_path
            pipeline_allow_loopback_urls = True
            pipeline_download_delay_seconds = 0

        class Ctx:
            settings = SettingsStub()

            def log(self, message, level="info"):
                pass

        base = f"http://127.0.0.1:{port}"
        # 正常静图 → downloaded
        async with session_factory() as session:
            good = Item(
                status=ItemStatus.DISCOVERED, source="reddit", source_id="still-ok",
                title="静图OK", media_url=f"{base}/ok.jpg", item_type="image_gallery",
            )
            session.add(good)
            await session.commit()
            good_id = good.id
        result = await DownloadStep().process(Ctx(), await _get_item(good_id))
        assert result.status == "downloaded"

        # 空文件 → 拒绝
        async with session_factory() as session:
            bad = Item(
                status=ItemStatus.DISCOVERED, source="reddit", source_id="still-empty",
                title="静图太小", media_url=f"{base}/tiny.jpg", item_type="image_gallery",
            )
            session.add(bad)
            await session.commit()
            bad_id = bad.id
        with pytest.raises(Exception) as exc:
            await DownloadStep().process(Ctx(), await _get_item(bad_id))
        assert "size 100" in str(exc.value)
    finally:
        server.should_exit = True
        await serve_task
        # 测试隔离（AXIOM §34）：清理残留条目
        async with session_factory() as session:
            for rid in (good_id, bad_id):
                row = await session.get(Item, rid)
                if row is not None:
                    await session.delete(row)
            await session.commit()


async def _get_item(item_id):
    from backend.models.item import Item
    from backend.models.session import session_factory

    async with session_factory() as session:
        return await session.get(Item, item_id)


# ---------- collect RSS 兜底 / HTML 嗅探（v0.3.1，参考原项目策略链） ----------

RSS_XML = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>猫猫视频</title>
    <link href="https://www.reddit.com/r/cats/comments/abc123/title/"/>
    <content type="html">&lt;p&gt;&lt;a href="https://v.redd.it/xyz123/DASH_720.mp4"&gt;video&lt;/a&gt;&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>风景图</title>
    <link href="https://www.reddit.com/r/pics/comments/def456/title/"/>
    <content type="html">&lt;img src="https://i.redd.it/img789.jpg"/&gt;</content>
  </entry>
  <entry>
    <title>纯文本</title>
    <link href="https://www.reddit.com/r/ask/comments/ghi789/title/"/>
    <content type="html">&lt;p&gt;no media&lt;/p&gt;</content>
  </entry>
</feed>"""


def test_rss_to_post_extracts_media() -> None:
    import xml.etree.ElementTree as ET

    from backend.pipeline.collectors.reddit import RedditCollector

    root = ET.fromstring(RSS_XML)
    entries = root.findall("{http://www.w3.org/2005/Atom}entry")
    posts = [RedditCollector._rss_to_post(e) for e in entries]
    posts = [p for p in posts if p is not None]

    assert len(posts) == 2  # 纯文本被过滤
    video = next(p for p in posts if p.source_id == "abc123")
    assert video.media_url == "https://v.redd.it/xyz123/DASH_720.mp4"
    assert video.item_type == "video_raw"
    img = next(p for p in posts if p.source_id == "def456")
    assert img.media_url == "https://i.redd.it/img789.jpg"
    assert img.item_type == "image_gallery"


def test_looks_like_html_sniff() -> None:
    from backend.pipeline.download import looks_like_html

    assert looks_like_html(b"<!doctype html><html><body>x</body></html>")
    assert looks_like_html(b"<html><head></head></html>")
    assert not looks_like_html(b"\x00\x00\x00\x18ftypmp42")
    assert not looks_like_html(b"\xff\xd8\xff\xe0")
    assert not looks_like_html(b"")


# ---------- Reddit OAuth 通道（v0.3.5） ----------


def test_oauth_disabled_without_credentials(monkeypatch) -> None:
    """未配置凭证时 _ensure_token 返回 None（保持匿名通道）。"""
    import httpx

    from backend.pipeline.collectors.reddit import RedditCollector

    class _Cfg:
        pipeline_reddit_client_id = ""
        pipeline_reddit_client_secret = ""

    monkeypatch.setattr("backend.pipeline.collectors.reddit.settings", _Cfg())
    c = RedditCollector(client=httpx.AsyncClient())
    assert asyncio.run(c._ensure_token()) is None  # noqa: SLF001 — 直接探内部，无 IO


@pytest.mark.asyncio
async def test_oauth_channel_fetches_posts(monkeypatch) -> None:
    """配置凭证后走 oauth.reddit.com 并解析 posts。"""
    import httpx

    from backend.pipeline.collectors.reddit import RedditCollector

    class _Cfg:
        pipeline_reddit_client_id = "cid"
        pipeline_reddit_client_secret = "cs"

    monkeypatch.setattr("backend.pipeline.collectors.reddit.settings", _Cfg())

    class FakeTransport(httpx.AsyncBaseTransport):
        def __init__(self) -> None:
            self.token_req = False
            self.list_req = False

        async def handle_async_request(self, request):
            if request.url.path == "/api/v1/access_token":
                self.token_req = True
                return httpx.Response(200, json={"access_token": "tok123"})
            if request.url.host == "oauth.reddit.com":
                self.list_req = True
                assert request.headers["authorization"] == "Bearer tok123"
                return httpx.Response(
                    200,
                    json={
                        "data": {
                            "children": [
                                {
                                    "data": {
                                        "id": "oa1",
                                        "title": "OAuth 帖子",
                                        "url": "https://i.redd.it/oa1.jpg",
                                        "permalink": "/r/pics/comments/oa1/x/",
                                        "score": 99,
                                        "upvote_ratio": 0.9,
                                        "num_comments": 7,
                                        "created_utc": 1_700_000_000,
                                        "is_video": False,
                                        "stickied": False,
                                    }
                                }
                            ]
                        }
                    },
                )
            return httpx.Response(404)

    transport = FakeTransport()
    c = RedditCollector(client=httpx.AsyncClient(transport=transport))
    posts = await c.collect(None, "pics", 10)
    assert transport.token_req and transport.list_req
    assert len(posts) == 1
    assert posts[0].source_id == "oa1"
    assert posts[0].item_type == "image_gallery"
    await c.aclose()


# ---------- 下载资源冷却（v0.3.6 冰川式） ----------


@pytest.mark.asyncio
async def test_resource_cooldown_backoff_and_thaw(monkeypatch) -> None:
    """403 → 域级冰封指数退避；冷却中跳过；成功解冻。"""
    from backend.models.pipeline import ResourceCooldown
    from backend.models.session import session_factory
    from backend.pipeline.download import (
        clear_resource_cooldown,
        domain_of,
        note_resource_failure,
        resource_cooldown_left,
    )

    url = "https://v.redd.it/abc123/DASH_720.mp4"
    assert domain_of(url) == "v.redd.it"

    # 两次失败 → level 2 → 时长 = base 300 × 2 = 600s
    d1 = await note_resource_failure(url, error="HTTP 403")
    d2 = await note_resource_failure(url, error="HTTP 403")
    assert d1 == 300
    assert d2 == 600

    left = await resource_cooldown_left("https://v.redd.it/other/DASH_720.mp4")
    assert left > 0  # 同域其他 URL 也被冻结

    # 其他域不受影响
    assert await resource_cooldown_left("https://i.redd.it/img.jpg") == 0

    # 解冻
    await clear_resource_cooldown(url)
    assert await resource_cooldown_left(url) == 0

    from sqlalchemy import select

    async with session_factory() as session:
        row = (
            await session.execute(
                select(ResourceCooldown).where(ResourceCooldown.domain == "v.redd.it")
            )
        ).scalar_one_or_none()
        assert row is None  # 解冻后记录删除


@pytest.mark.asyncio
async def test_download_skips_frozen_domain() -> None:
    """冰封中的域：下载步骤跳过，条目保持 discovered 不 FAILED。"""
    from backend.config import settings
    from backend.pipeline.base import StepContext
    from backend.pipeline.download import note_resource_failure
    from backend.pipeline.steps.download import DownloadStep

    await note_resource_failure("https://v.redd.it/zzz/DASH_720.mp4", error="403")

    class Item:
        media_url = "https://v.redd.it/zzz/DASH_720.mp4"
        source_url = "https://www.reddit.com/r/t/comments/zzz/x/"
        item_type = "video_raw"
        title = "frozen"
        id = None
        output_dir = None

    ctx = StepContext(
        run_id="t", settings=settings, ai=None,
        emit=lambda e: None,
    )
    result = await DownloadStep().process(ctx, Item())
    assert result.status == "discovered"  # 保持状态，等待冷却到期自动重试
    assert result.skip is True  # 摘要计「跳过」而非「成功」
