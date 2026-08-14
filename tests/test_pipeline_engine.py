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
from backend.models.session import session_factory
from backend.pipeline.collectors.base import RawPost
from backend.pipeline.collectors.reddit import FakeRedditCollector

FAKE_NARRATION = (
    "这段内容来自 Reddit 的热门讨论，讲述城市夜行者的生存美学，"
    "值得每个创作者看一眼。这是一个超过二十字足以通过脚本检查的叙述文本。"
)


class ScoringLLM:
    """LLM fake: returns a rubric JSON for score calls, narration otherwise.

    v0.3.0：低分用例按标题「低分」触发（预过滤配置化后 reddit_score 不再
    恒低）；维度带实际值供服务端重算验证。
    """

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        # v0.11.6：只拼接用户消息（系统提示词含「低分」字样曾误触低分分支）
        content = "\n".join(
            (getattr(m, "content", None) or m.get("content"))
            for m in messages
            if (getattr(m, "role", None) or m.get("role")) == "user"
        )
        if "来源：" in content:
            import re

            match = re.search(r"score: (\d+)", content)
            if "低分" in content or (match and int(match.group(1)) < 10):
                text = json.dumps(
                    {"total": 4.0, "dimensions": {"entertainment": 4.0},
                     "reasons": ["测试低分"]},
                    ensure_ascii=False,
                )
            else:
                text = json.dumps(
                    {"total": 9.9, "dimensions": {"novelty": 7, "depth": 8},
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
                score=60,
                upvote_ratio=0.86,
                created_utc=1_700_000_001.0,
                item_type="video_raw",
            ),
            RawPost(
                source_id="bad-1",
                title="一个下载会失败的测试条目",
                source_url=f"{remote_server}/missing.mp4",
                media_url=f"{remote_server}/missing.mp4",
                score=90,
                upvote_ratio=0.86,
                created_utc=1_700_000_002.0,
                item_type="video_raw",
            ),
            RawPost(
                source_id="pref-1",
                title="预过滤拒绝（低分低比例）",
                source_url=f"{remote_server}/media.mp4",
                media_url=f"{remote_server}/media.mp4",
                score=1,
                upvote_ratio=0.2,
                created_utc=1_700_000_003.0,
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


async def _wait_jobs_done(client, timeout_s: float = 60.0):
    """v0.10.1 异步队列：轮询直到后台任务完全结束（running=false）并返回 jobs。

    仅看 jobs 表 status 会早退——job 落库 COMPLETED 后任务还要算 delta/
    commit/emit 收尾，此间 pipeline.running 仍为 true。
    """
    deadline = asyncio.get_running_loop().time() + timeout_s
    last_status = {}
    while asyncio.get_running_loop().time() < deadline:
        status = (await client.get("/api/pipeline/status")).json()
        if not status.get("running"):
            resp = await client.get("/api/pipeline/jobs")
            return resp.json().get("jobs", [])
        last_status = status
        await asyncio.sleep(0.3)
    raise AssertionError(
        f"timed out waiting for pipeline idle (busy: {last_status.get('job')})"
    )


@pytest.mark.asyncio
async def test_chain_to_review_gate(client, pipeline_env) -> None:
    resp = await client.post("/api/pipeline/chain", params={"limit": 10})
    assert resp.status_code == 200, resp.text
    # v0.10.1 异步队列：立即返回入队（不再阻塞等待整链完成）
    assert resp.json()["status"] == "queued"
    assert resp.json()["job"] == "chain"

    queued = await _wait_items(client, "queued", 1, timeout_s=40)
    good = next(q for q in queued if q["source_id"] == "good-1")
    assert good["status"] == "queued"
    assert good["title"].startswith("一个很棒")
    assert good["script_json"] is not None
    assert good["raw_path"] is not None
    assert good["cover_path"] is not None
    assert good["score_total"] == 7.5

    # v0.2.0 低分不再 reject：low-1 → 低分标记 + 继续流程进入审核队列（人工决定）
    queued = await _wait_items(client, "queued", 2)
    good = next(q for q in queued if q["source_id"] == "good-1")
    assert good["status"] == "queued"
    assert good["title"].startswith("一个很棒")
    assert good["script_json"] is not None
    assert good["raw_path"] is not None
    assert good["cover_path"] is not None
    assert good["score_total"] == 7.5
    low = next(q for q in queued if q["source_id"] == "low-1")
    assert low["is_lowscore"] is True

    failed = await client.get("/api/pipeline/items", params={"status": "failed"})
    failed = failed.json()
    assert len(failed) == 1
    assert "download" in (failed[0]["error"] or "").lower()

    counts = (await client.get("/api/pipeline/items/counts")).json()
    assert counts.get("queued") == 2
    assert counts.get("failed") == 1
    # v0.3.0 预过滤配置化：低分低比例（score=1/ratio=0.2）LLM 前直接拒绝
    rejected = (await client.get("/api/pipeline/items", params={"status": "rejected"})).json()
    assert any(i["source_id"] == "pref-1" for i in rejected)


@pytest.mark.asyncio
async def test_approve_reject_publish(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    # v0.10.1 异步队列：等整链后台完成后才能发布（single-flight）
    await _wait_jobs_done(client)
    queued = await _wait_items(client, "queued", 1)
    good = queued[0]
    rejected_id = await _mk_item(status="rejected")

    resp = await client.post(f"/api/pipeline/items/{good['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"

    resp = await client.post("/api/pipeline/run", params={"step": "publish"})
    assert resp.status_code == 200, resp.text
    # v0.10.1 异步队列：run 立即返回入队，发布结果经轮询确认
    assert resp.json()["status"] == "queued"
    published = await _wait_items(client, "published", 1)
    assert published[0]["publish_json"]["target"] == "noop"

    resp = await client.post(f"/api/pipeline/items/{good['id']}/reject")
    assert resp.status_code == 409  # published items cannot be rejected

    resp = await client.post(f"/api/pipeline/items/{rejected_id}/retry")
    assert resp.status_code == 409  # rejected is not retryable

    resp = await client.post(f"/api/pipeline/items/{good['id']}/approve")
    assert resp.status_code == 409  # already published


@pytest.mark.asyncio
async def test_retry_failed_item(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    failed = await _wait_items(client, "failed", 1)
    item = failed[0]

    # v5.9 回退：下载失败（无 raw_path）→ discovered 重新走 download→score 链
    resp = await client.post(f"/api/pipeline/items/{item['id']}/retry")
    assert resp.status_code == 200
    assert resp.json()["status"] == "discovered"
    detail = (await client.get("/api/pipeline/items", params={"status": "discovered"})).json()
    assert any(i["id"] == item["id"] for i in detail)


@pytest.mark.asyncio
async def test_requeue_rejected_item(client, pipeline_env) -> None:
    rejected_id = await _mk_item(status="rejected")

    resp = await client.post(f"/api/pipeline/items/{rejected_id}/requeue")
    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"

    # 重复 requeue 非法（409）
    resp = await client.post(f"/api/pipeline/items/{rejected_id}/requeue")
    assert resp.status_code == 409

    queued = (await client.get("/api/pipeline/items", params={"status": "queued"})).json()
    assert any(i["id"] == rejected_id for i in queued)


@pytest.mark.asyncio
async def test_step_order(client, pipeline_env) -> None:
    """v0.8.6 流程顺序：score → download → produce → publish（collect 前置除外）。"""
    steps = (await client.get("/api/pipeline/steps")).json()["steps"]
    assert steps == ["score", "download", "produce", "publish"]


@pytest.mark.asyncio
async def test_jobs_and_sources(client, pipeline_env) -> None:
    await client.post("/api/pipeline/chain", params={"limit": 10})
    jobs = await _wait_jobs_done(client)
    names = {j["job"] for j in jobs}
    assert {"collect", "score", "download", "produce"} <= names
    # 断言本次 chain 产生的最新四步全部 completed（jobs 含历史 job——
    # 前面测试的失败 job 不参与；列表按 started_at 倒序，同名取首个）
    latest: dict[str, dict] = {}
    for j in jobs:
        latest.setdefault(j["job"], j)
    chain_jobs = [latest[n] for n in ("collect", "score", "download", "produce") if n in latest]
    assert all(j["status"] == "completed" for j in chain_jobs)

    sources = (await client.get("/api/pipeline/sources")).json()
    assert len(sources) >= 1  # 默认源列表（v0.8.6 真实 subreddit）
    assert all(s["source"] == "reddit" for s in sources)
    assert sources[0]["ok_count"] >= 1
    assert sources[0]["cursor"] is not None


@pytest.mark.asyncio
async def test_single_flight_guard(client, pipeline_env) -> None:
    first = client.post("/api/pipeline/run", params={"step": "collect"})
    second = client.post("/api/pipeline/run", params={"step": "score"})
    responses = await asyncio.gather(first, second)
    codes = sorted(r.status_code for r in responses)
    assert codes == [200, 409]


async def _mk_item(**kw) -> str:
    """独立造一条流水线条目（不依赖共享 chain 状态，测试自包含）。"""
    import uuid as _uuid

    from backend.models.item import Item

    item = Item(
        status=kw.pop("status", "queued"),
        source="test",
        source_id=f"t-{_uuid.uuid4().hex[:8]}",
        title=kw.pop("title", "测试条目"),
        subreddit="r/test",
        author="tester",
        source_url="https://example.com/post",
        **kw,
    )
    async with session_factory() as session:
        session.add(item)
        await session.commit()
        await session.refresh(item)
    return str(item.id)


@pytest.mark.asyncio
async def test_meta_and_publish_one(client, pipeline_env) -> None:
    """v5.10 独立发布环节：meta 更新（标题/标签/排期）+ 单条发布（noop）+ 自制发布。"""
    good_id = await _mk_item()

    # 审核通过 → approved
    resp = await client.post(f"/api/pipeline/items/{good_id}/approve")
    assert resp.json()["status"] == "approved"

    # 更新发布元数据（B站标题/标签/排期）
    resp = await client.put(
        f"/api/pipeline/items/{good_id}/meta",
        json={
            "bili_title": "我的定制标题",
            "bili_tags": "动物,高能",
            "scheduled_at": "2026-09-01T10:00:00",
        },
    )
    assert resp.status_code == 200, resp.text

    items = (await client.get("/api/pipeline/items", params={"status": "approved"})).json()
    target = next(i for i in items if i["id"] == good_id)
    assert target["script_json"]["bili_title"] == "我的定制标题"
    assert target["scheduled_at"] is not None

    # 分区/tid：设置后显式清空（0 = 回默认，v0.2.2）
    resp = await client.put(
        f"/api/pipeline/items/{good_id}/meta",
        json={"bili_tid": 201},
    )
    assert resp.status_code == 200, resp.text
    items = (await client.get("/api/pipeline/items", params={"status": "approved"})).json()
    assert next(i for i in items if i["id"] == good_id)["script_json"]["bili_tid"] == 201
    resp = await client.put(
        f"/api/pipeline/items/{good_id}/meta",
        json={"bili_tid": 0},
    )
    assert resp.status_code == 200, resp.text
    items = (await client.get("/api/pipeline/items", params={"status": "approved"})).json()
    assert "bili_tid" not in next(i for i in items if i["id"] == good_id)["script_json"]
    # 排期显式清空（'' → None，v0.2.2 修复：此前 null 无法清除）
    resp = await client.put(
        f"/api/pipeline/items/{good_id}/meta",
        json={"scheduled_at": ""},
    )
    assert resp.status_code == 200, resp.text
    items = (await client.get("/api/pipeline/items", params={"status": "approved"})).json()
    assert next(i for i in items if i["id"] == good_id)["scheduled_at"] is None

    # 单条发布（pipeline_publish_target=noop，安全）
    resp = await client.post(f"/api/pipeline/items/{good_id}/publish")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "published"

    # 已发布条目可重新发布（v5.11：published → 再次上传新稿件）
    resp = await client.post(f"/api/pipeline/items/{good_id}/publish")
    assert resp.status_code == 200, resp.text

    # 自制发布（selfmade=1）
    second_id = await _mk_item()
    await client.post(f"/api/pipeline/items/{second_id}/approve")
    resp = await client.post(f"/api/pipeline/items/{second_id}/publish", params={"selfmade": 1})
    assert resp.status_code == 200, resp.text
    published = (await client.get("/api/pipeline/items", params={"status": "published"})).json()
    assert any(i["id"] == second_id for i in published)

    # 未审核条目不可发布（409）
    third_id = await _mk_item(status="queued")
    resp = await client.post(f"/api/pipeline/items/{third_id}/publish")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_requeue_approved(client, pipeline_env) -> None:
    """审核通过后可改回待审（v5.10 requeue 扩展：approved → queued）。"""
    item_id = await _mk_item(status="approved")
    resp = await client.post(f"/api/pipeline/items/{item_id}/requeue")
    assert resp.status_code == 200
    assert resp.json()["status"] == "queued"


class _FakeTTS:
    """v0.11.7 故事产线测试：合成一段真实可解码的静音 mp3（ffmpeg 生成）。"""

    async def synthesize(self, text: str, voice: str = "") -> bytes:
        import asyncio
        import tempfile
        from pathlib import Path

        async def _make() -> bytes:
            out = Path(tempfile.mkdtemp()) / "s.mp3"
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
                "-t", "1", "-q:a", "9", str(out),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.communicate()
            return out.read_bytes()

        return await _make()


@pytest.mark.asyncio
async def test_chain_text_story_to_queued(client, pipeline_env) -> None:
    """v0.11.7：text_only 帖全链路——采集保留 → 下载跳过 → 故事合成 → queued。"""
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.collectors.reddit import FakeRedditCollector

    registry = ServiceRegistry.get()
    engine = registry.pipeline.engine
    original_ai = engine.ai
    original_collector = engine.collector
    try:
        engine.ai = AIRouter(llm=ScoringLLM(), image=None, tts=_FakeTTS())
        engine.collector = FakeRedditCollector([
            RawPost(
                source_id="story-1",
                title="他第一次在她面前哭了",
                source_url="https://www.reddit.com/comments/story1/",
                media_url="",
                author="tester", score=88, upvote_ratio=0.9,
                num_comments=42, created_utc=1_700_000_000.0,
                item_type="text_only",
                selftext="我母亲去世后，父亲沉默了三年。昨天他第一次开口，"
                         "说想和我一起去看海。我哭了整整一个晚上。" * 3,
            ),
        ])
        resp = await client.post("/api/pipeline/chain", params={"limit": 5})
        assert resp.status_code == 200
        # 共享 DB 含存量 queued 条目——必须按 source_id 精确等待 story-1
        deadline = asyncio.get_running_loop().time() + 90
        item = None
        while asyncio.get_running_loop().time() < deadline:
            resp = await client.get("/api/pipeline/items", params={"status": "queued"})
            found = [q for q in resp.json() if q["source_id"] == "story-1"]
            if found:
                item = found[0]
                break
            await asyncio.sleep(0.3)
        assert item is not None, "story-1 未在超时内进入审核队列"
        assert item["status"] == "queued"
        assert item["raw_path"] is None, "text_only 无 raw（下载跳过）"
        assert item["video_path"], "故事产线产出成片"
        assert (item["script_json"] or {}).get("narration")
    finally:
        engine.ai = original_ai
        engine.collector = original_collector
