"""Monoline 融合域 Phase 1.3：store + 大纲 + service 文本路径。"""

import asyncio
from uuid import UUID

import pytest
from monoline_fakes import FakeHF, StubTTS

from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore
from backend.monoline.service import MonolineService
from backend.monoline.store import MonolineStore

SCRIPT = "第一段内容，介绍背景。第二段内容，展开细节。第三段内容，总结收尾。"


@pytest.fixture()
def svc(tmp_path):
    files = FileStore(data_dir=tmp_path / "data")
    return MonolineService(files=files, hub=EventHub(), store=MonolineStore(),
                           tts_provider=StubTTS(), hf=FakeHF())


async def test_outline_build_current_apply(svc: MonolineService) -> None:
    created = await svc.create_job(SCRIPT, config={"brand": "Test"})
    jid = UUID(created["id"])

    view = await svc.build_outline(jid)
    assert view["beats"] == 3
    assert view["est_seconds"] > 0
    assert all(e["kind"] for e in view["entries"])

    again = await svc.get_outline(jid)
    assert again["beats"] == 3

    merged = [
        {"text": view["entries"][0]["text"] + view["entries"][1]["text"]},
        {"text": view["entries"][2]["text"], "kind": "quote"},
    ]
    applied = await svc.apply_outline(jid, merged)
    assert applied["beats"] == 2
    assert applied["pinned"] >= 1

    job = await svc.get_job(jid)
    assert job is not None and job["title"]
    kinds = [s["key"] for s in job["stages"]]
    assert "script" in kinds and "plan" in kinds


async def test_run_preserves_manual_outline(svc: MonolineService) -> None:
    """B2 核心回归：审稿合并后运行，手工大纲不被重建覆盖。"""
    created = await svc.create_job(SCRIPT)
    jid = UUID(created["id"])
    view = await svc.build_outline(jid)
    merged = [
        {"text": view["entries"][0]["text"] + view["entries"][1]["text"]},
        {"text": view["entries"][2]["text"]},
    ]
    applied = await svc.apply_outline(jid, merged)
    assert applied["beats"] == 2

    await svc.run(jid)
    for _ in range(600):
        if not svc.running:
            break
        await asyncio.sleep(0.1)
    job = await svc.get_job(jid)
    assert job is not None and job["status"] == "succeeded", (job or {}).get("error")
    segs = await svc.store.get_segments(jid)
    assert len(segs) == 2  # 仍是合并后的 2 拍，而非原文的 3 拍
    assert segs[0]["text"] == merged[0]["text"]


async def test_run_full_chain_succeeds(svc: MonolineService) -> None:
    created = await svc.create_job(SCRIPT)
    jid = UUID(created["id"])
    await svc.run(jid)
    for _ in range(600):
        if not svc.running:
            break
        await asyncio.sleep(0.1)
    assert not svc.running
    job = await svc.get_job(jid)
    assert job is not None and job["status"] == "succeeded", (job or {}).get("error")
    stages = {s["key"]: s["status"] for s in job["stages"]}
    for key in ("script", "tts", "assemble", "plan", "fonts", "compose",
                "gate", "render", "deliver"):
        assert stages.get(key) == "succeeded", (key, stages)
    assert (svc.ws_root(jid) / "composition" / "audio" / "narration.wav").exists()
    assert (svc.ws_root(jid) / "composition" / "index.html").exists()
    assert (job.get("total_duration") or 0) > 0
    arts = await svc.store.list_artifacts(jid)
    assert {a["kind"] for a in arts} >= {"composition_html", "render_mp4"}


async def test_reconcile_parks_interrupted(svc: MonolineService) -> None:
    created = await svc.create_job(SCRIPT)
    jid = UUID(created["id"])
    await svc.store.update_job(jid, status="running")
    ids = await svc.reconcile()
    assert created["id"] in ids
    job = await svc.get_job(jid)
    assert job is not None and job["status"] == "queued"


async def test_delete_job_cleans_workspace(svc: MonolineService) -> None:
    created = await svc.create_job(SCRIPT)
    jid = UUID(created["id"])
    await svc.build_outline(jid)
    assert svc.ws_root(jid).exists()
    assert await svc.delete_job(jid) is True
    assert not svc.ws_root(jid).exists()
    assert await svc.get_job(jid) is None
