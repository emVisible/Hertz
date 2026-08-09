"""Download engine tests: chunked transfer, resume, SSRF guard.

The "remote" server is a Starlette app with FileResponse (which honors
Range requests) served over ASGITransport — no real sockets needed.
"""

import os

import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response, StreamingResponse
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request

from backend.download.engine import ChunkedDownloader
from backend.download.parser import parse_url
from backend.download.sources.generic import GenericSource

BIG_SIZE = 20 * 1024 * 1024  # 20 MB > 2 × 8 MB chunks


def make_file_server(payload: bytes, path: str | None = None) -> tuple[FastAPI, list[str]]:
    """File server counting the Range headers it serves."""
    seen: list[str] = []
    if path is None:
        import tempfile

        with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as tmp:
            tmp.write(payload)
            path = tmp.name
    else:
        with open(path, "wb") as f:
            f.write(payload)
    app = FastAPI()

    @app.get("/asset")
    async def asset(request: Request):
        if "Range" in request.headers:
            seen.append(request.headers["Range"])
        return FileResponse(path)

    return app, seen


@pytest.fixture
def payload() -> bytes:
    return os.urandom(BIG_SIZE)


def _client_for(app: FastAPI) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://cdn.test")


@pytest.fixture
async def engine_client(payload: bytes, tmp_path):
    app, seen = make_file_server(payload, str(tmp_path / "asset.bin"))
    client = _client_for(app)
    yield client, seen, payload
    await client.aclose()


async def test_chunked_download_completes(tmp_path, engine_client):
    client, seen, payload = engine_client
    dest = tmp_path / "video.mp4"
    downloader = ChunkedDownloader(
        "https://cdn.test/asset",
        dest,
        client=client,
        url_checker=lambda _u: True,
        chunk_size=8 * 1024 * 1024,
        max_workers=3,
    )
    result = await downloader.download()
    assert result.ok, result.error
    assert dest.read_bytes() == payload
    assert not dest.with_suffix(".mp4.part").exists()
    chunk_ranges = [r for r in seen if not r.endswith("-0") or r != "bytes=0-0"]
    assert len(chunk_ranges) == 3  # 20MB / 8MB chunks → 3 range requests


async def test_resume_skips_done_chunks(tmp_path, engine_client):
    client, seen, payload = engine_client
    dest = tmp_path / "video.mp4"
    chunk_size = 8 * 1024 * 1024

    # Simulate an interrupted first run: first chunk done, recorded in sidecar.
    part = dest.with_suffix(".mp4.part")
    meta = dest.with_suffix(".mp4.part.json")
    part.write_bytes(payload[:chunk_size])
    meta.write_text(f'{{"total": {len(payload)}, "starts": [0]}}', encoding="utf-8")
    downloader = ChunkedDownloader(
        "https://cdn.test/asset",
        dest,
        client=client,
        url_checker=lambda _u: True,
        chunk_size=chunk_size,
        max_workers=3,
    )
    result = await downloader.download()
    assert result.ok, result.error
    assert dest.read_bytes() == payload
    # only the remaining two chunks were fetched (probe requests 0-0)
    chunk_starts = {str(8388608), str(16777216)}
    fetched = [r for r in seen if any(r.startswith(f"bytes={s}-") for s in chunk_starts)]
    assert len(fetched) == 2


async def test_unknown_length_streams_full_body(tmp_path):
    """Unknown-length download must not send a Range header on the initial
    request (regression: Range was `{}` at start=0, which httpx rejects).

    A full download() with total=None requires a HEAD response that carries
    Accept-Ranges without Content-Length — ASGITransport always injects a
    length, so we exercise _stream_range directly (the path is reached in
    production when a server advertises ranges but no content length).
    """
    payload = b"y" * 64 * 1024
    seen: list[str | None] = []
    app = FastAPI()

    @app.get("/asset")
    async def asset(request: Request):
        if "Range" in request.headers:
            seen.append(request.headers["Range"])
            start = int(request.headers["Range"].split("=")[1].split("-")[0])
            return Response(
                payload[start:],
                status_code=206,
                headers={
                    "Content-Range": f"bytes {start}-{len(payload) - 1}/{len(payload)}",
                    "Accept-Ranges": "bytes",
                },
            )
        seen.append(None)
        return StreamingResponse(iter([payload]), headers={"Accept-Ranges": "bytes"})

    client = _client_for(app)
    try:
        dest = tmp_path / "u.bin"
        downloader = ChunkedDownloader(
            "https://cdn.test/asset",
            dest,
            client=client,
            url_checker=lambda _u: True,
        )
        # start=0 → no Range header (full-body request); start>0 → Range sent
        part = downloader.part_path
        part.write_bytes(b"")
        await downloader._stream_range(part, 0)
        await downloader._stream_range(part, 100)
        assert seen == [None, "bytes=100-"], seen
        assert part.read_bytes() == payload
    finally:
        await client.aclose()


async def test_ssrf_blocks_private_hosts(tmp_path):
    dest = tmp_path / "x.bin"
    client = AsyncClient(transport=ASGITransport(app=make_file_server(b"x")[0]), base_url="https://cdn.test")
    downloader = ChunkedDownloader(
        "https://127.0.0.1/asset",
        dest,
        client=client,
    )
    result = await downloader.download()
    assert not result.ok
    assert "SSRF_BLOCKED" in result.error
    await client.aclose()


def test_ssrf_rejects_bad_schemes_and_credentials():
    from backend.download.engine import is_safe_media_url

    assert not is_safe_media_url("http://example.com/x.mp4")
    assert not is_safe_media_url("https://user:pass@example.com/x.mp4")
    assert is_safe_media_url("https://example.com/x.mp4")


def test_ssrf_trusts_media_cdns_without_dns():
    """已知可信媒体域直通（v0.2.8，参考原项目静态白名单）——
    代理环境下本地 DNS 解析失败不再误报 SSRF_BLOCKED。"""
    from backend.download.engine import is_safe_media_url

    # Reddit 媒体 CDN（采集来源）
    assert is_safe_media_url("https://v.redd.it/abc123/DASH_720.mp4")
    assert is_safe_media_url("https://i.redd.it/xyz.jpg")
    assert is_safe_media_url("https://preview.redd.it/xyz.jpg")
    assert is_safe_media_url("https://www.redditmedia.com/x/1.mp4")
    assert is_safe_media_url("https://external-preview.redd.it/abc.jpg")
    # 手动下载来源
    assert is_safe_media_url("https://www.bilibili.com/video/BV1xx411c7mD")
    assert is_safe_media_url("https://b23.tv/abc")
    assert is_safe_media_url("https://www.youtube.com/watch?v=abc")
    # 子域逃逸拒绝（evil-redd.it 不匹配 .redd.it 后缀）
    assert not is_safe_media_url("https://evil-redd.it/x.mp4")
    assert not is_safe_media_url("https://redd.it.evil.com/x.mp4")
    # 非 https 白名单域同样拒绝
    assert not is_safe_media_url("http://v.redd.it/x.mp4")


def test_parse_url_classification():
    assert parse_url("https://www.bilibili.com/video/BV1xx411c7mD").provider == "bilibili"
    assert parse_url("BV1xx411c7mD").provider == "bilibili"
    assert parse_url("av170001").provider == "bilibili"
    assert parse_url("https://youtu.be/abc123").provider == "youtube"
    assert parse_url("https://www.youtube.com/watch?v=abc123").provider == "youtube"
    direct = parse_url("https://cdn.example.com/a/video.mp4")
    assert direct.provider == "generic" and direct.kind == "video"
    page = parse_url("https://example.com/gallery")
    assert page.provider == "generic" and page.kind == "page"


def test_parse_url_ssrf_host_whitelist():
    """Provider classification is hostname-based, not string-search based —
    lookalike URLs must never trigger yt-dlp (AXIOM §8.1)."""
    for evil in (
        "http://127.0.0.1:8080/youtube.com/watch?v=x",
        "http://localhost/bilibili.com/video/BV1",
        "http://192.168.1.10/youtu.be/abc",
        "http://evil.internal/b23.tv/x",
    ):
        parsed = parse_url(evil)
        assert parsed.provider == "generic", f"{evil} → {parsed}"
    assert parse_url("https://m.youtube.com/watch?v=x").provider == "youtube"
    assert parse_url("https://b23.tv/abc").provider == "bilibili"


async def test_generic_source_scan_page():
    html = """
    <html><body>
      <img src="/img/1.jpg">
      <video src="https://cdn.example.com/clip.mp4"></video>
      <a href="https://cdn.example.com/doc.pdf">pdf</a>
      <a href="/page/2">rel</a>
      <img src="data:image/png;base64,AAAA">
    </body></html>
    """
    app = FastAPI()

    @app.get("/gallery")
    async def gallery():
        from fastapi.responses import HTMLResponse

        return HTMLResponse(html)

    client = _client_for(app)
    assets = await GenericSource(client).scan_page("https://cdn.test/gallery")
    kinds = {a.kind for a in assets}
    assert "image" in kinds and "video" in kinds and "document" in kinds
    assert all(not a.url.startswith("data:") for a in assets)
    await client.aclose()
