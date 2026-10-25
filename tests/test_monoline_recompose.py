"""Monoline 融合域 A1：秒级重组（reorder/retheme/revoice/resynth）。"""

import asyncio
from uuid import UUID

import pytest
from monoline_fakes import FakeHF, StubTTS

from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore
from backend.monoline import recompose as recompose_mod
from backend.monoline.service import MonolineService
from backend.monoline.store import MonolineStore

SCRIPT = "第一段内容，介绍背景。第二段内容，展开细节。第三段内容，总结收尾。"


@pytest.fixture()
def svc(tmp_path):
    files = FileStore(data_dir=tmp_path / "data")
    return MonolineService(files=files, hub=EventHub(), store=MonolineStore(),
                           tts_provider=StubTTS(), hf=FakeHF())


@pytest.fixture(autouse=True)
def _fast_fonts(stub_font_subset):
    """本文件端到端不消费 woff2 内容，跳过 4.8s/次的真字体子集（见 conftest）。"""
    yield


async def _ready_job(svc: MonolineService) -> UUID:
    created = await svc.create_job(SCRIPT)
    jid = UUID(created["id"])
    await svc.run(jid)
    for _ in range(600):
        if not svc.running:
            break
        await asyncio.sleep(0.1)
    job = await svc.get_job(jid)
    assert job is not None and job["status"] == "succeeded", (job or {}).get("error")
    return jid


async def test_reorder_permutes_with_audio(svc: MonolineService) -> None:
    jid = await _ready_job(svc)
    before = [s["text"] for s in await svc.store.get_segments(jid)]
    out = await recompose_mod.reorder(svc.store, svc.ws_root(jid), jid, [2, 0, 1], hf=FakeHF())
    assert out["order"] == [2, 0, 1]
    after = [s["text"] for s in await svc.store.get_segments(jid)]
    assert after == [before[2], before[0], before[1]]
    # 音频跟随：新首拍 wav 非空且时长>0
    assert after and (await svc.store.get_segments(jid))[0]["tts_duration"] > 0
    with pytest.raises(ValueError):
        await recompose_mod.reorder(svc.store, svc.ws_root(jid), jid, [0, 0, 1], hf=FakeHF())


async def test_retheme_keeps_manual_kind(svc: MonolineService) -> None:
    jid = await _ready_job(svc)
    out = await recompose_mod.retheme(svc.store, svc.ws_root(jid), jid, hf=FakeHF())
    assert out["version"] >= 2 and out["ok"] is True
    plan = await svc.store.get_plan(jid)
    assert plan is not None and plan["source"] == "manual"


async def test_revoice_and_resynth(svc: MonolineService) -> None:
    jid = await _ready_job(svc)
    out = await recompose_mod.revoice(svc.store, svc.ws_root(jid), jid, "zm_yunxi",
                          tts_provider=StubTTS(), hf=FakeHF())
    assert out["voice"] == "zm_yunxi"
    job = await svc.get_job(jid)
    assert job is not None and job["config"]["voice"] == "zm_yunxi"
    with pytest.raises(ValueError):
        await recompose_mod.revoice(svc.store, svc.ws_root(jid), jid, "nope",
                        tts_provider=StubTTS(), hf=FakeHF())

    out2 = await recompose_mod.resynth_segment(
        svc.store, svc.ws_root(jid), jid, 0, "改写后的第一拍。",
        tts_provider=StubTTS(), hf=FakeHF())
    assert out2["beat_duration"] > 0
    segs = await svc.store.get_segments(jid)
    assert segs[0]["text"] == "改写后的第一拍。"
    with pytest.raises(ValueError):
        await recompose_mod.resynth_segment(svc.store, svc.ws_root(jid), jid, 1, "   ",
                                tts_provider=StubTTS(), hf=FakeHF())
    with pytest.raises(IndexError):
        await recompose_mod.resynth_segment(svc.store, svc.ws_root(jid), jid, 99, "x",
                                tts_provider=StubTTS(), hf=FakeHF())
