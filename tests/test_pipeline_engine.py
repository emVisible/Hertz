"""Wave 4 pipeline tests: collect → score → download → produce + review gate.

The collector is faked (canned RawPosts), the LLM is faked (JSON score or
narration depending on the call), and media comes from a local uvicorn
Range server so the real ChunkedDownloader and (if ffmpeg exists) the real
producer run end-to-end. Everything stays on localhost — no real Reddit,
no real LLM, no real Bilibili (publish target is "noop").
"""

import asyncio
import json
import socket
import subprocess
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse

from backend.ai.router import AIRouter
from backend.factory.registry import ServiceRegistry
from backend.pipeline.collectors.base import RawPost
from backend.pipeline.collectors.reddit import FakeRedditCollector

FAKE_NARRATION = (
    "这段内容来自 Reddit 的热门讨论，讲述城市夜行者的生存美学，"
    "值得每个创作者看一眼。这是一个超过二十字足以通过脚本检查的叙述文本。"
)


class ScoringLLM:
    """LLM fake: returns a rubric JSON for score calls, narration otherwise."""

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        content = "\n".join(getattr(m, "content", None) or m.get("content") for m in messages)
        if "来源：" in content:
            import re

            match = re.search(r"score: (\d+)", content)
            if match and int(match.group(1)) < 10:
                text = json.dumps(
                    {"total": 4.0, "dimensions": {}, "reasons": ["测试低分"]},
                    ensure_ascii=False,
                )
            else:
                text = json.dumps(
                    {"total": 7.5, "dimensions": {"novelty": 7, "depth": 8},
                     "reasons": ["测试高分"]},
                    ensure_ascii=False,
                )
        else:
            text = FAKE_NARRATION
        for ch in text:
            yield ch

    async def aclose(self) -> None:
        pass


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def video_payload() -> bytes:
    """A real 2s test video when ffmpeg exists, junk bytes otherwise."""
    import tempfile

    try:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "sample.mp4"
            proc = subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
                    str(out),
                ],
                capture_output=True,
                check=False,
            )
            if proc.returncode == 0 and out.exists():
                return out.read_bytes()
    except FileNotFoundError:
        pass
    return b"not-a-real-video" * 64


@pytest.fixture
async def remote_server(video_payload: bytes, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    (src_dir / "media.mp4").write_bytes(video_payload)
    app = FastAPI()

    @app.get("/media.mp4")
    async def media():
        return FileResponse(str(src_dir / "media.mp4"))

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    for _ in range(50):
        if server.started:
            break
        await asyncio.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    await task


@pytest.fixture
async def pipeline_env(client, remote_server, tmp_path):
    """Point the pipeline engine at fakes + a temp data dir; restore after."""
    from backend.config import settings

    registry = ServiceRegistry.get()
    engine = registry.pipeline.engine
    original_ai = engine.ai
    original_collector = engine.collector
    original_data_dir = settings.data_dir

    engine.ai = AIRouter(llm=ScoringLLM(), image=None, tts=None)
    settings.data_dir = tmp_path / "data"
    engine.collector = FakeRedditCollector(
        [
            RawPost(
                source_id="good-1",
                title="一个很棒的夜晚观察笔记标题",
                source_url=f"{remote_server}/media.mp4",
                media_url=f"{remote_server}/media.mp4",
                author="tester",
                score=120,
                upvote_ratio=0.9,
                num_comments=42,
                created_utc=1_700_000_000.0,
                item_type="video_raw",
            ),
            RawPost(
                source_id="low-1",
                title="低分",
                source_url=f"{remote_server}/media.mp4",
                media_url=f"{remote_server}/media.mp4",
                score=1,
                upvote_ratio=0.2,
                created_utc=1_700_000_001.0,
                item_type="video_raw",
            ),
            RawPost(
                source_id="bad-1",
                title="一个下载会失败的测试条目",
                source_url=f"{remote_server}/missing.mp4",
                media_url=f"{remote_server}/missing.mp4",
                score=90,
                upvote_ratio=0.8,
                created_utc=1_700_000_002.0,
                item_type="video_raw",
            ),
        ]
    )
    yield registry
    engine.ai = original_ai
    engine.collector = original_collector
    settings.data_dir = original_data_dir


async def _wait_items(client, status: str, expected: int, timeout_s: float = 20.0):
    deadline = asyncio.get_running_loop().time() + timeout_s
    while asyncio.get_running_loop().time() < deadline:
        resp = await client.get("/api/pipeline/items", params={"status": status})
        items = resp.json()
        if len(items) >= expected:
            return items
        await asyncio.sleep(0.2)
    raise AssertionError(f"timed out waiting for {expected} item(s) in state {status}")


@pytest.mark.asyncio
async def test_chain_to_review_gate(client, pipeline_env) -> None:
    resp = await client.post("/api/pipeline/chain", params={"limit": 10})
    assert resp.status_code == 200, resp.text
    results = resp.json()
    assert "collect" in results and "produce" in results

    queued = await _wait_items(client, "queued", 1)
    assert queued[0]["status"] == "queued"
    assert queued[0]["title"].startswith("一个很棒")
    assert queued[0]["script_json"] is not None
    assert queued[0]["raw_path"] is not None
    assert queued[0]["cover_path"] is not None
    assert queued[0]["score_total"] == 7.5

    rejected = await client.get("/api/pipeline/items", params={"status": "rejected"})
    rejected = rejected.json()
    assert len(rejected) == 1
    assert rejected[0]["source_id"] == "low-1"

    failed = await client.get("/api/pipeline/items", params={"status": "failed"})
    failed = failed.json()
    assert len(failed) == 1
    assert "download" in (failed[0]["error"] or "").lower()

    counts = (await client.get("/api/pipeline/items/counts")).json()
    assert counts.get("queued") == 1
    assert counts.get("rejected") == 1
    assert counts.get("failed") == 1


@pytest.mark.asyncio
async def test_approve_reject_publish(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    queued = await _wait_items(client, "queued", 1)
    good = queued[0]

    rejected = (await client.get("/api/pipeline/items", params={"status": "rejected"})).json()[0]

    resp = await client.post(f"/api/pipeline/items/{good['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"

    resp = await client.post("/api/pipeline/run", params={"step": "publish"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["summary"]["processed"] == 1

    published = (await client.get("/api/pipeline/items", params={"status": "published"})).json()
    assert len(published) == 1
    assert published[0]["publish_json"]["target"] == "noop"

    resp = await client.post(f"/api/pipeline/items/{good['id']}/reject")
    assert resp.status_code == 409  # published items cannot be rejected

    resp = await client.post(f"/api/pipeline/items/{rejected['id']}/retry")
    assert resp.status_code == 409  # rejected is not retryable

    resp = await client.post(f"/api/pipeline/items/{good['id']}/approve")
    assert resp.status_code == 409  # already published


@pytest.mark.asyncio
async def test_retry_failed_item(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    failed = await _wait_items(client, "failed", 1)
    item = failed[0]

    resp = await client.post(f"/api/pipeline/items/{item['id']}/retry")
    assert resp.status_code == 200
    assert resp.json()["status"] == "downloaded"
    detail = (await client.get("/api/pipeline/items", params={"status": "downloaded"})).json()
    assert any(i["id"] == item["id"] for i in detail)


@pytest.mark.asyncio
async def test_jobs_and_sources(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    jobs = (await client.get("/api/pipeline/jobs")).json()
    assert len(jobs) >= 4  # collect, score, download, produce
    names = {j["job"] for j in jobs}
    assert {"collect", "score", "download", "produce"} <= names
    assert all(j["status"] == "completed" for j in jobs)

    sources = (await client.get("/api/pipeline/sources")).json()
    assert len(sources) == 1
    assert sources[0]["source"] == "reddit"
    assert sources[0]["ok_count"] >= 1
    assert sources[0]["cursor"] is not None


@pytest.mark.asyncio
async def test_single_flight_guard(client, pipeline_env) -> None:
    first = client.post("/api/pipeline/run", params={"step": "collect"})
    second = client.post("/api/pipeline/run", params={"step": "score"})
    responses = await asyncio.gather(first, second)
    codes = sorted(r.status_code for r in responses)
    assert codes == [200, 409]
