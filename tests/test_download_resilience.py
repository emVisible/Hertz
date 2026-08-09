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
    """v.redd.it 视频 → DASH 变体 + 原 URL + permalink 兜底；去重。"""
    url = "https://v.redd.it/abc123/DASH_720.mp4"
    permalink = "https://www.reddit.com/r/funny/comments/abc123/title/"
    cands = media_candidates(url, permalink)
    assert cands[0] == url  # 已是 DASH_720.mp4：原样在前
    assert "https://v.redd.it/abc123/DASHPlaylist.mpd" in cands
    assert "https://v.redd.it/abc123/HLS_720.mpd" in cands
    assert permalink in cands
    assert len(cands) == len(set(cands))  # 去重

    # 非 v.redd.it：只保留原 URL + permalink
    plain = media_candidates("https://i.redd.it/x.jpg", "https://www.reddit.com/r/a/comments/1/x/")
    assert plain[0] == "https://i.redd.it/x.jpg"
    assert len(plain) == 2


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
