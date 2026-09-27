"""秒级重组（移植自上游 `pipeline/recompose.py`）：不经过 TTS 全量，只重做受影响环节。

- recompose()：fonts + compose + lint（文本/主题/顺序变化后的统一出口）；
- reorder()：节拍置换（音频跟随，无需重 TTS）+ 重 concat/计时 + 场景重排；
- retheme()：换主题保留手工编辑；
- revoice()：全片换音色（重 TTS 全部节拍）；
- resynth_segment()：单拍改文本 → 重 TTS 该拍 → 重 concat/计时 → 关键词重提炼。

Hertz 适配：repo/settings → store（MonolineStore）+ 工作区根；TTS 经注入式
provider（与 runner.run_tts 同口，clean+rate 语义在 provider 内）；lint 经注入式 HF。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import UUID

from .hf import HF
from .runner import VENDOR_DIR, _ffprobe_duration
from .store import MonolineStore
from .workspace import Workspace


async def recompose(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                    hf: HF | None = None) -> dict:
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    ws = Workspace(ws_root).ensure()
    plan_row = await store.get_plan(job_id)
    if plan_row is None:
        raise ValueError("no plan to recompose")
    from backend.infrastructure.storage import file_store

    from .sceneplan import ScenePlan
    from .subset import collect_glyphs, subset_font

    plan = ScenePlan.model_validate(plan_row["plan_json"])
    config = job.get("config") or {}
    segs = await store.get_segments(job_id)

    from .runner import _flat

    texts = [s["text"] for s in segs] + [str(v) for sc in plan.scenes for v in _flat(sc.slots)]
    glyphs = collect_glyphs(texts, brand=plan.brand.label)
    res = await asyncio.to_thread(
        subset_font, glyphs, ws.font_woff2,
        cache_dir=file_store.data_dir / "models" / "fonts")
    if res.missing:
        return {"ok": False,
                "error": f"font missing glyphs: {res.missing[:8]}",
                "version": plan_row["version"]}

    from .audio_mix import ensure_voice_track
    from .compose import render_composition, vendor_composition_assets
    from .timings import Timings

    timings = Timings.model_validate_json((ws.ir / "timings.json").read_text(encoding="utf-8"))
    vo_src = await ensure_voice_track(ws, config, timings.total)
    html = await asyncio.to_thread(
        render_composition, timings, plan, title=job.get("title") or "",
        vo_src=vo_src, layout=config.get("layout", "minimal"))
    ws.index_html.write_text(html, encoding="utf-8")
    await asyncio.to_thread(vendor_composition_assets, ws, VENDOR_DIR, html)

    lint_ok, lint_data = await (hf or HF()).lint(str(ws.composition))
    errors = [f for f in (lint_data.get("findings") or []) if f.get("severity") == "error"]
    return {"ok": lint_ok, "version": plan_row["version"],
            "html_bytes": len(html), "lint_errors": errors[:8]}


async def _reconcat(store: MonolineStore, ws: Workspace, job_id: UUID) -> float:
    """重 concat 全片旁白 + 重计时回写，返回总时长（reorder/revoice/resynth 共用）。"""
    from .timings import Timings

    segs = await store.get_segments(job_id)
    concat = ws.tts / "concat.txt"
    concat.write_text("".join(f"file '{s['wav_path']}'\n" for s in segs), encoding="utf-8")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
        "-c", "copy", str(ws.narration_wav),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg concat failed: {err.decode()[-300:]}")
    timings = Timings.from_durations([s["text"] for s in segs],
                                     [float(s["tts_duration"]) for s in segs])
    (ws.ir / "timings.json").write_text(timings.model_dump_json(indent=2), encoding="utf-8")
    for sgm in timings.segments:
        await store.update_segment(job_id, sgm.i, start=sgm.start, end=sgm.end)
    await store.update_job(job_id, total_duration=timings.total)
    return timings.total


async def _synth_beat(store: MonolineStore, ws: Workspace, job_id: UUID, i: int, text: str,
                      *, voice: str, lang: str, speed: float, tts_provider) -> float:
    """单拍合成 + 落库，返回实测时长。"""
    linef = ws.tts / f"line_{i:03d}.txt"
    wav = ws.tts / f"seg_{i:03d}.wav"
    linef.write_text(text, encoding="utf-8")
    wav_bytes = await tts_provider.synthesize(
        text, voice, f"+{(speed - 1) * 100:.0f}%" if speed != 1.0 else "+0%")
    wav.write_bytes(wav_bytes)
    dur = await _ffprobe_duration(wav)
    await store.update_segment(job_id, i, text=text, wav_path=str(wav),
                               wav_bytes=len(wav_bytes), tts_duration=dur,
                               voice=voice, lang=lang, speed=speed)
    return dur


async def reorder(store: MonolineStore, ws_root: Path, job_id: UUID, order: list[int], *,
                  hf: HF | None = None) -> dict:
    """节拍置换：order[p] 为新位置 p 上的 OLD 下标。音频跟随，无需重 TTS。"""
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    n = len(segs)
    if sorted(order) != list(range(n)):
        raise ValueError(f"order must be a permutation of 0..{n - 1}")
    ws = Workspace(ws_root).ensure()

    rows = []
    for p, old in enumerate(order):
        s = dict(segs[old])
        s["i"] = p
        s["line_no"] = p + 1
        rows.append(s)
    await store.replace_segments(job_id, rows)

    total = await _reconcat(store, ws, job_id)

    plan_row = await store.get_plan(job_id)
    ver = plan_row["version"] if plan_row else 0
    if plan_row:
        plan = dict(plan_row["plan_json"])
        scenes = plan.get("scenes", [])
        if len(scenes) == n:
            plan["scenes"] = [{**scenes[old], "i": p} for p, old in enumerate(order)]
            ver = await store.save_plan(job_id, plan, "manual:reorder", [])

    result = await recompose(store, ws_root, job_id, hf=hf)
    return {"version": ver, "total_duration": total, "order": order, **result}


async def retheme(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                  hf: HF | None = None) -> dict:
    """换主题/品牌外观（保留手工场景编辑），秒级重绘."""
    from .sceneplan import overlays_from_config
    from .themes import resolve as resolve_theme

    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    plan_row = await store.get_plan(job_id)
    if plan_row is None:
        raise ValueError("no plan to retheme")
    config = job.get("config") or {}
    plan = dict(plan_row["plan_json"])
    plan["theme"] = resolve_theme(config).model_dump()
    plan.update(overlays_from_config(config))
    ver = await store.save_plan(job_id, plan, "manual", [])
    result = await recompose(store, ws_root, job_id, hf=hf)
    return {"version": ver, **result}


async def revoice(store: MonolineStore, ws_root: Path, job_id: UUID, voice: str, *,
                  tts_provider, hf: HF | None = None) -> dict:
    """全片换音色：lang 随 voice 前缀联动；plan 内容不变，版本 +1  bust 预览缓存."""
    from . import voices as _voices

    if not _voices.is_known_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    if not segs:
        raise ValueError("no beats yet — run the job first")
    plan_row = await store.get_plan(job_id)
    if plan_row is None:
        raise ValueError("no plan to revoice")

    config = dict(job.get("config") or {})
    config["voice"] = voice
    config["lang"] = _voices.voice_lang(voice)
    speed = float(config.get("speed", 1.0))
    await store.update_job(job_id, config=config)
    lang = config["lang"]

    ws = Workspace(ws_root).ensure()
    for s in segs:
        await _synth_beat(store, ws, job_id, s["i"], s["text"],
                          voice=voice, lang=lang, speed=speed, tts_provider=tts_provider)
    total = await _reconcat(store, ws, job_id)
    ver = await store.save_plan(job_id, plan_row["plan_json"], "manual:revoice", [])
    result = await recompose(store, ws_root, job_id, hf=hf)
    return {"version": ver, "total_duration": total, "voice": voice, **result}


async def resynth_segment(store: MonolineStore, ws_root: Path, job_id: UUID, i: int,
                          new_text: str, *, tts_provider, hf: HF | None = None) -> dict:
    """单拍改文本 → 重 TTS 该拍 → 重 concat/计时 → 关键词重提炼（保持 kind）→ 重组."""
    from .planner import distill_keyword
    from .sceneplan import DIAGRAM_KINDS

    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    ws = Workspace(ws_root).ensure()

    segs = await store.get_segments(job_id)
    if not (0 <= i < len(segs)):
        raise IndexError(f"segment {i} out of range")
    new_text = new_text.strip()
    if not new_text:
        raise ValueError("narration text cannot be empty")

    dur = await _synth_beat(store, ws, job_id, i, new_text,
                            voice=config.get("voice") or "zf_xiaoxiao",
                            lang=config.get("lang") or "zh",
                            speed=float(config.get("speed", 1.0)),
                            tts_provider=tts_provider)
    total = await _reconcat(store, ws, job_id)

    plan_row = await store.get_plan(job_id)
    ver = 0
    if plan_row:
        plan = dict(plan_row["plan_json"])
        scenes = plan.get("scenes", [])
        if 0 <= i < len(scenes):
            kw, clean = distill_keyword(new_text)
            slots = scenes[i].get("slots", {})
            kind = scenes[i]["kind"]
            key = {"section": "title", "note": "body", "definition": "gloss",
                   "quote": "q", "stat": "label"}.get(kind, "headline")
            # Diagram kinds 渲染提取节点而非 headline：重提炼只会写无人阅读的槽
            if kind not in DIAGRAM_KINDS:
                slots[key] = kw
                slots["verbatim"] = (not clean)
            scenes[i]["slots"] = slots
            scenes[i]["source"] = "rules:resynth"
        ver = await store.save_plan(job_id, plan, "manual", [])
    result = await recompose(store, ws_root, job_id, hf=hf)
    return {"version": ver, "total_duration": total, "beat_duration": dur, **result}


async def revoice_segment(store: MonolineStore, ws_root: Path, job_id: UUID, i: int,
                          voice: str, *, tts_provider, hf: HF | None = None) -> dict:
    """单拍换音色：该拍用新音色重 TTS（文本不变，关键词不动）→ 重 concat/计时 → 重组。

    segments 表本就按拍存 voice/lang/speed，此前只有全片 revoice 用得上；
    plan 内容不变，仅 bump 版本 bust 预览缓存。
    """
    from . import voices as _voices

    if not _voices.is_known_voice(voice):
        raise ValueError(f"unknown voice {voice!r}")
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    if not (0 <= i < len(segs)):
        raise IndexError(f"segment {i} out of range")
    config = job.get("config") or {}
    ws = Workspace(ws_root).ensure()

    dur = await _synth_beat(store, ws, job_id, i, segs[i]["text"],
                            voice=voice, lang=_voices.voice_lang(voice) or "zh",
                            speed=float(config.get("speed", 1.0)),
                            tts_provider=tts_provider)
    total = await _reconcat(store, ws, job_id)
    plan_row = await store.get_plan(job_id)
    ver = 0
    if plan_row:
        ver = await store.save_plan(job_id, plan_row["plan_json"], "manual:revoice", [])
    result = await recompose(store, ws_root, job_id, hf=hf)
    return {"version": ver, "total_duration": total, "beat_duration": dur,
            "beat": i, "voice": voice, **result}
