"""Monoline 融合域 Phase 1.5：/api/monoline/* 端到端（ASGI client，真 DB）。"""

import asyncio
from uuid import UUID

import pytest
from monoline_fakes import FakeHF, StubTTS

from backend.factory.registry import ServiceRegistry

SCRIPT = "第一段内容，介绍背景。第二段内容，展开细节。第三段内容，总结收尾。"


@pytest.fixture()
def stub_tts():
    svc = ServiceRegistry.get().monoline
    prev_tts, prev_hf = svc._tts_provider, svc._hf  # noqa: SLF001
    svc._tts_provider = StubTTS()  # noqa: SLF001
    svc._hf = FakeHF()  # noqa: SLF001
    yield
    svc._tts_provider, svc._hf = prev_tts, prev_hf  # noqa: SLF001


async def test_status_and_health(client) -> None:
    r = await client.get("/api/monoline/status")
    assert r.status_code == 200 and r.json()["running"] is False
    r = await client.get("/api/monoline/health")
    body = r.json()
    assert r.status_code == 200 and body["voices"] == 25
    assert body["ffmpeg"] is True


async def test_create_validation(client) -> None:
    r = await client.post("/api/monoline/jobs", json={"script": ""})
    assert r.status_code == 422
    r = await client.post("/api/monoline/jobs", json={"script": "x" * 200_001})
    assert r.status_code == 422


async def test_job_crud_and_outline(client) -> None:
    r = await client.post("/api/monoline/jobs", json={"script": SCRIPT})
    assert r.status_code == 200
    jid = r.json()["id"]
    UUID(jid)

    r = await client.get(f"/api/monoline/jobs/{jid}")
    assert r.status_code == 200 and r.json()["status"] == "draft"

    r = await client.post(f"/api/monoline/jobs/{jid}/outline")
    assert r.status_code == 200 and r.json()["beats"] == 3

    r = await client.get(f"/api/monoline/jobs/{jid}/outline")
    assert r.json()["beats"] == 3

    entries = r.json()["entries"]
    edits = [{"text": entries[0]["text"] + entries[1]["text"]},
             {"text": entries[2]["text"]}]
    r = await client.patch(f"/api/monoline/jobs/{jid}/outline", json={"entries": edits})
    assert r.json()["beats"] == 2

    r = await client.delete(f"/api/monoline/jobs/{jid}")
    assert r.json() == {"ok": True}
    r = await client.get(f"/api/monoline/jobs/{jid}")
    assert r.status_code == 404


async def test_run_cancel_events_files(client, stub_tts) -> None:
    r = await client.post("/api/monoline/jobs", json={"script": SCRIPT})
    jid = r.json()["id"]

    r = await client.post(f"/api/monoline/jobs/{jid}/run")
    assert r.status_code == 200 and r.json()["status"] == "queued"
    # 单航班：第二个 run 应 409
    r = await client.post("/api/monoline/jobs", json={"script": SCRIPT})
    jid2 = r.json()["id"]
    r = await client.post(f"/api/monoline/jobs/{jid2}/run")
    assert r.status_code == 409

    for _ in range(600):
        r = await client.get("/api/monoline/status")
        if not r.json()["running"]:
            break
        await asyncio.sleep(0.1)
    r = await client.get(f"/api/monoline/jobs/{jid}")
    assert r.json()["status"] == "succeeded", r.json().get("error")
    stages = {s["key"]: s["status"] for s in r.json()["stages"]}
    assert stages.get("render") == "succeeded" and stages.get("deliver") == "succeeded"

    r = await client.get(f"/api/monoline/jobs/{jid}/events?limit=50")
    assert len(r.json()["events"]) > 0

    r = await client.get(f"/api/monoline/jobs/{jid}/files/composition/audio/narration.wav")
    assert r.status_code == 200 and r.content[:4] == b"RIFF"
    slug = (await client.get(f"/api/monoline/jobs/{jid}")).json()["slug"]
    r = await client.get(f"/api/monoline/jobs/{jid}/files/renders/{slug}.mp4")
    assert r.status_code == 200

    r = await client.get(f"/api/monoline/jobs/{jid}/download")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]

    r = await client.get(f"/api/monoline/jobs/{jid}/subtitles?fmt=srt")
    assert r.status_code == 200 and r.text.startswith("1\n")
    r = await client.get(f"/api/monoline/jobs/{jid}/subtitles?fmt=vtt")
    assert r.status_code == 200 and r.text.startswith("WEBVTT")
    r = await client.get(f"/api/monoline/jobs/{jid}/subtitles?fmt=ass")
    assert r.status_code == 422

    r = await client.get(f"/api/monoline/jobs/{jid}/poster")
    assert r.status_code == 200 and r.content[:2] == b"\xff\xd8"

    # 无成片作业：download 404、poster 409
    r = await client.post("/api/monoline/jobs", json={"script": SCRIPT})
    jid3 = r.json()["id"]
    r = await client.get(f"/api/monoline/jobs/{jid3}/download")
    assert r.status_code == 404
    r = await client.get(f"/api/monoline/jobs/{jid3}/poster")
    assert r.status_code == 409

    # 编码后的 ../..：httpx 不做归一化，服务端 containment 应 403
    r = await client.get(f"/api/monoline/jobs/{jid}/files/%2E%2E/%2E%2E/x.wav")
    assert r.status_code == 403
    r = await client.get(f"/api/monoline/jobs/{jid}/files/nope.wav")
    assert r.status_code == 404


async def test_voice_sample_needs_weights(client) -> None:
    # 测试 DATA_DIR 下无权重 → 502 明示；未知音色 404
    r = await client.get("/api/monoline/voices/no-such-voice/sample")
    assert r.status_code == 404
    r = await client.get("/api/monoline/voices/zf_xiaoxiao/sample")
    assert r.status_code == 502


async def test_themes_voices_presets(client) -> None:
    r = await client.get("/api/monoline/themes")
    ids = [t["id"] for t in r.json()["themes"]]
    assert ids == ["mono-ink", "mono-noir", "mono-paper", "mono-slate"]
    r = await client.get("/api/monoline/voices")
    assert r.json()["default"] == "zf_xiaoxiao" and len(r.json()["voices"]) == 25
    r = await client.post("/api/monoline/presets",
                          json={"name": "t", "config": {"theme": "mono-noir"}})
    pid = r.json()["id"]
    r = await client.get("/api/monoline/presets")
    assert any(p["id"] == pid for p in r.json()["presets"])
    r = await client.delete(f"/api/monoline/presets/{pid}")
    assert r.json() == {"ok": True}


async def _succeeded_job(client, stub_tts, script: str = SCRIPT) -> str:
    r = await client.post("/api/monoline/jobs", json={"script": script})
    jid = r.json()["id"]
    r = await client.post(f"/api/monoline/jobs/{jid}/run")
    assert r.status_code == 200
    for _ in range(600):
        r = await client.get(f"/api/monoline/jobs/{jid}")
        if r.json()["status"] == "succeeded":
            return jid
        await asyncio.sleep(0.2)
    raise AssertionError(f"run failed: {r.json().get('error')}")


async def test_per_beat_endpoints(client, stub_tts) -> None:
    jid = await _succeeded_job(client, stub_tts)

    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/0", json={"text": "重写第一拍。"})
    assert r.status_code == 200 and r.json()["beat_duration"] > 0
    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/9", json={"text": "x"})
    assert r.status_code == 422
    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/1", json={"text": "  "})
    assert r.status_code == 422

    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0", json={"kind": "quote"})
    assert r.status_code == 200 and r.json()["ok"] is True
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0", json={"kind": "nope"})
    assert r.status_code == 422

    r = await client.post(f"/api/monoline/jobs/{jid}/reorder", json={"order": [2, 0, 1]})
    assert r.status_code == 200 and r.json()["order"] == [2, 0, 1]
    r = await client.post(f"/api/monoline/jobs/{jid}/reorder", json={"order": [0, 0, 1]})
    assert r.status_code == 422

    r = await client.post(f"/api/monoline/jobs/{jid}/voice", json={"voice": "zm_yunxi"})
    assert r.status_code == 200 and r.json()["voice"] == "zm_yunxi"
    r = await client.post(f"/api/monoline/jobs/{jid}/voice", json={"voice": "nope"})
    assert r.status_code == 422

    r = await client.patch(f"/api/monoline/jobs/{jid}/config", json={"theme": "mono-paper"})
    assert r.status_code == 200
    plan = (await client.get(f"/api/monoline/jobs/{jid}/outline")).json()
    assert plan["beats"] == 3
    r = await client.patch(f"/api/monoline/jobs/{jid}/config", json={"theme": "nope"})
    assert r.status_code == 422
    r = await client.patch(f"/api/monoline/jobs/{jid}/config", json={"nope": 1})
    assert r.status_code == 422


async def test_suggest_and_script_validation(client, monkeypatch) -> None:
    from backend.factory.registry import ServiceRegistry

    r = await client.post("/api/monoline/jobs", json={"script": SCRIPT})
    jid = r.json()["id"]
    await client.post(f"/api/monoline/jobs/{jid}/outline")

    r = await client.post(f"/api/monoline/jobs/{jid}/plan/scenes/9/suggest")
    assert r.status_code == 422
    r = await client.post("/api/monoline/script", json={"topic": ""})
    assert r.status_code == 422

    monkeypatch.setattr(ServiceRegistry.get(), "ai", None)
    r = await client.post(f"/api/monoline/jobs/{jid}/plan/scenes/0/suggest")
    assert r.status_code == 502 and "LLM" in r.json()["detail"]
    r = await client.post("/api/monoline/script", json={"topic": "测试主题"})
    assert r.status_code == 502


async def test_patch_scene_slots_reset(client, stub_tts) -> None:
    jid = await _succeeded_job(client, stub_tts)
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0",
                           json={"kind": "image", "slots": {"image": "x", "verbatim": True}})
    assert r.status_code == 200
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0",
                           json={"kind": "statement", "slots": {}})
    assert r.status_code == 200
    outline = (await client.get(f"/api/monoline/jobs/{jid}/outline")).json()
    assert outline["entries"][0]["kind"] == "statement"


async def test_revoice_beat_and_llm_config(client, stub_tts) -> None:
    jid = await _succeeded_job(client, stub_tts)
    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/0/voice",
                           json={"voice": "zm_yunxi"})
    assert r.status_code == 200 and r.json()["voice"] == "zm_yunxi"
    assert r.json()["beat"] == 0
    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/0/voice",
                           json={"voice": "nope"})
    assert r.status_code == 422
    r = await client.patch(f"/api/monoline/jobs/{jid}/segments/9/voice",
                           json={"voice": "zm_yunxi"})
    assert r.status_code == 422

    r = await client.patch(f"/api/monoline/jobs/{jid}/config",
                           json={"llm_plan": True, "llm_batch_beats": 2})
    assert r.status_code == 200
    job = (await client.get(f"/api/monoline/jobs/{jid}")).json()
    assert job["config"]["llm_batch_beats"] == 2

    r = await client.get("/api/monoline/icons")
    assert r.status_code == 200 and r.json()["count"] >= 150
    r = await client.get("/api/monoline/brand/logo")
    assert r.status_code == 404


async def test_patch_scene_variant_and_icon(client, stub_tts) -> None:
    jid = await _succeeded_job(client, stub_tts)
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0",
                           json={"slots": {"variant": "flush"}})
    assert r.status_code == 200
    outline = (await client.get(f"/api/monoline/jobs/{jid}/outline")).json()
    assert outline["entries"]
    plan = await client.get(f"/api/monoline/jobs/{jid}")
    assert plan.status_code == 200
    # variant 清空回自动
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0",
                           json={"slots": {"variant": None}})
    assert r.status_code == 200
    r = await client.patch(f"/api/monoline/jobs/{jid}/plan/scenes/0",
                           json={"slots": {"icon": "cpu"}})
    assert r.status_code == 200
