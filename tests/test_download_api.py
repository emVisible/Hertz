"""End-to-end download API test: real uvicorn Range server → API → file on disk."""

import os
import socket

import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse

from backend.factory.registry import ServiceRegistry

SIZE = 12 * 1024 * 1024  # 12 MB


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _make_remote(payload: bytes, path: str) -> FastAPI:
    with open(path, "wb") as f:
        f.write(payload)
    app = FastAPI()

    @app.get("/media.mp4")
    async def media():
        return FileResponse(path, media_type="video/mp4")

    return app


@pytest.fixture(autouse=True)
async def _restore_download_state():
    """Restore registry download dir + url_checker after every test.

    Tests mutate the singleton (roundtrip bypasses SSRF, ssrf test enables
    it); without restoration a single `-k` run permanently disables checks.
    """
    registry = ServiceRegistry.get()
    orig_dir = registry.download.download_dir
    orig_checker = registry.download.url_checker
    yield
    registry.download.download_dir = orig_dir
    registry.download.url_checker = orig_checker


@pytest.fixture
async def remote_server(payload: bytes, tmp_path):
    port = _free_port()
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    app = _make_remote(payload, str(src_dir / "media.mp4"))
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(50):
        if server.started:
            break
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}/media.mp4"
    server.should_exit = True
    await task


@pytest.fixture
def payload() -> bytes:
    return os.urandom(SIZE)


async def _wait_status(
    client, task_id: str, want: str, timeout_s: float = 30
) -> dict:
    import time

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        resp = await client.get("/api/download/tasks")
        tasks = resp.json()
        task = next(t for t in tasks if t["id"] == task_id)
        if task["status"] == want:
            return task
        await asyncio.sleep(0.1)
    raise AssertionError(f"task {task_id} never reached {want}: {task}")


async def _wait_idle(timeout_s: float = 30) -> None:
    """Wait until all download worker tasks have finished (avoid cross-test leaks)."""
    import time

    registry = ServiceRegistry.get()
    deadline = time.monotonic() + timeout_s
    done = asyncio.Event()

    async def poll() -> None:
        while registry.download.pool.running():
            if time.monotonic() >= deadline:
                return
            await asyncio.sleep(0.05)
        done.set()

    await asyncio.wait_for(poll(), timeout=timeout_s + 1)
    await done.wait()
    assert not registry.download.pool.running(), "download workers still running"


def _reset_service(tmp_path) -> None:
    registry = ServiceRegistry.get()
    registry.download.download_dir = tmp_path
    registry.download.url_checker = lambda _u: True


async def test_full_download_roundtrip(client, payload, tmp_path, remote_server):
    _reset_service(tmp_path)

    resp = await client.post("/api/download/tasks", json={"url": remote_server})
    assert resp.status_code == 200, resp.text
    task = resp.json()
    assert task["provider"] == "generic"

    await client.post(f"/api/download/tasks/{task['id']}/start")
    done = await _wait_status(client, task["id"], "completed")
    assert done["progress"] == 100.0
    assert done["total_bytes"] == SIZE
    await _wait_idle()

    files = [p for p in tmp_path.iterdir() if p.is_file()]
    assert len(files) == 1, files
    assert files[0].read_bytes() == payload

    # delete → task gone
    await client.delete(f"/api/download/tasks/{task['id']}")
    resp = await client.get("/api/download/tasks")
    assert task["id"] not in [t["id"] for t in resp.json()]


async def test_parse_direct_url(client):
    resp = await client.get("/api/download/parse", params={"url": "https://example.com/a/video.mp4"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] == "generic"
    assert body["formats"][0]["format_id"] == "original"


async def test_ssrf_rejects_private_url(client, tmp_path):
    registry = ServiceRegistry.get()
    registry.download.download_dir = tmp_path
    registry.download.url_checker = None  # default strict checker
    resp = await client.post("/api/download/tasks", json={"url": "https://127.0.0.1:8080/x.mp4"})
    assert resp.status_code == 200  # task creation is offline; SSRF enforced at download time

    task = resp.json()
    started = await client.post(f"/api/download/tasks/{task['id']}/start")
    assert started.status_code in (200, 409)
    failed = await _wait_status(client, task["id"], "failed")
    assert "SSRF_BLOCKED" in failed["error"]
    await _wait_idle()
    await client.delete(f"/api/download/tasks/{task['id']}")


import asyncio  # noqa: E402
