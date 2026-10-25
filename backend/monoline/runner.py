"""Monoline 运行阶段（移植自上游 `pipeline/runner.py`）。

script/plan 走 outline 文本路径；tts/assemble 音频路径；fonts/compose/gate/
render/deliver 完整链（CLI-first：render 经 HyperFrames CLI，见 hf.py）。
续跑语义与上游一致：input_hash 相等 + 产物存在即 skipped。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from .ffmpeg import run_ffmpeg
from .hf import HF, _lint_summary

# 模块级导入是测试的打桩位（tests/test_monoline_llm 用 monkeypatch 换 suggest）
from .llm_plan import suggest
from .store import MonolineStore
from .timings import Timings
from .workspace import Workspace

VENDOR_DIR = Path(__file__).parent / "vendor"
# A0：TTS 输入语义版本（clean+rate 对齐后旧 wav 缓存失效一次）
TTS_INPUT_VERSION = "v2-clean"
_MIME = {"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"}


class JobCancelledError(Exception):
    """阶段边界上用户取消时抛出。"""


def _h(*parts: object) -> str:
    return hashlib.sha256("⋄".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def _now():
    return datetime.now(UTC)


async def _ffprobe_duration(path: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    return float(out.decode().strip())


async def _check_cancel(store: MonolineStore, job_id: UUID, cancel: asyncio.Event | None,
                        key: str) -> None:
    if cancel is not None and cancel.is_set():
        await store.update_job(job_id, status="cancelled", finished_at=_now())
        await store.add_event(job_id, "stage_finished", stage_key=key,
                              level="warn", message="cancelled")
        raise JobCancelledError(key)


# R4 音频生命力：位置能量曲线（开场/收束稍慢、中间稍快）+ 章节拍后停顿。
# 位置系数叠在用户语速上；章节停顿直接焊进该拍 wav 尾（0.4s 静音）。
_POS_FACTOR_FIRST = 0.95
_POS_FACTOR_LAST = 0.97
_POS_FACTOR_MID = 1.02
_SECTION_PAUSE_S = 0.4


def position_factor(i: int, n: int) -> float:
    """拍位置 → 语速系数。单拍恒 1.0（无从谈起伏）。"""
    if n <= 1:
        return 1.0
    if i == 0:
        return _POS_FACTOR_FIRST
    if i == n - 1:
        return _POS_FACTOR_LAST
    return _POS_FACTOR_MID


def append_silence(wav: Path, seconds: float) -> float:
    """wav 尾追加静音，返回新时长（读→拼→写回，原位覆盖）。"""
    import numpy as np
    import soundfile as sf

    audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
    pad = np.zeros((int(seconds * sr), audio.shape[1]), dtype=np.float32)
    out = np.concatenate([audio, pad], axis=0)
    sf.write(str(wav), out, sr)
    return round(len(out) / sr, 3)


async def run_tts(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                  voice: str, lang: str, speed: float,
                  tts_provider, cancel: asyncio.Event | None = None,
                  emit=None) -> dict:
    """逐拍合成；文本/音色/语速不变复用已有 wav（与上游 s_tts 同语义）。

    R4：每拍实际语速 = 用户语速 × 位置系数；章节拍 wav 尾焊 0.4s 停顿。
    kinds 经纯规则 storyboard 就地推导（毫秒级，无需等 plan 阶段）。
    """
    from .outline import storyboard

    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    script = job.get("script_text") or ""
    config = job.get("config") or {}
    kinds = [sc.get("kind", "") for sc in storyboard(
        [s["text"] for s in segs], script=script, brand=config.get("brand", "Monoline"))]
    kinds_hash = _h(json.dumps(kinds, ensure_ascii=False))
    ihash = _h(script, voice, lang, speed, TTS_INPUT_VERSION, kinds_hash)

    prior = await store.get_stage(job_id, "tts")
    n = len(segs)
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash
            and all((ws.tts / f"seg_{i:03d}.wav").exists() for i in range(n))):
        await store.add_event(job_id, "stage_finished", stage_key="tts", message="skipped (cached)")
        if emit:
            await emit("tts", {"stage": "tts", "status": "skipped"})
        return {"skipped": True}
    # 逐拍复用仅当输入指纹一致（版本键变化/改音色后强制全量重合成，防旧 wav 残留）
    allow_reuse = bool(prior and prior.get("input_hash") == ihash)

    await _check_cancel(store, job_id, cancel, "tts")
    await store.upsert_stage(job_id, "tts", 1, status="running",
                             started_at=_now(), input_hash=ihash)
    await store.add_event(job_id, "stage_started", stage_key="tts", message="tts")
    if emit:
        await emit("tts", {"stage": "tts", "status": "running"})
    try:
        durs: list[float] = []
        reused = 0
        for s in segs:
            await _check_cancel(store, job_id, cancel, "tts")
            linef = ws.tts / f"line_{s['i']:03d}.txt"
            wav = ws.tts / f"seg_{s['i']:03d}.wav"
            prev = linef.read_text(encoding="utf-8") if linef.exists() else None
            if (allow_reuse and wav.exists() and prev == s["text"] and s.get("tts_duration")
                    and s.get("voice") == voice and s.get("speed") == speed):
                durs.append(float(s["tts_duration"]))
                reused += 1
                continue
            linef.write_text(s["text"], encoding="utf-8")
            if emit:
                await emit("tts", {"stage": "tts", "status": "running",
                                   "message": f"合成第 {s['i']+1}/{len(segs)} 拍",
                                   "beat": s["i"], "of": len(segs)})
            # R4：位置系数叠入语速（首 0.95 / 尾 0.97 / 中 1.02）
            eff_speed = round(speed * position_factor(s["i"], len(segs)), 3)
            wav_bytes = await tts_provider.synthesize(
                s["text"], voice,
                f"+{(eff_speed - 1) * 100:.0f}%" if eff_speed != 1.0 else "+0%")
            wav.write_bytes(wav_bytes)
            dur = float(s.get("tts_duration") or 0.0)
            if not dur:
                # provider 给字节时按 ffprobe 实测（与上游 payload.durationSeconds 回退一致）
                dur = await _ffprobe_duration(wav)
            # R4：章节拍尾焊 0.4s 停顿（剪辑感；kinds 与 ihash 同源，变则重合成）
            if s["i"] < len(kinds) and kinds[s["i"]] == "section":
                dur = await asyncio.to_thread(append_silence, wav, _SECTION_PAUSE_S)
            durs.append(dur)
            await store.update_segment(job_id, s["i"], wav_path=str(wav),
                                       wav_bytes=wav.stat().st_size, tts_duration=dur,
                                       voice=voice, lang=lang, speed=speed)
        out = {"beats": len(durs), "audio_seconds": round(sum(durs), 3), "reused": reused}
        await store.upsert_stage(job_id, "tts", 1, status="succeeded",
                                 finished_at=_now(), output_json=out)
        await store.add_event(job_id, "stage_finished", stage_key="tts", message="tts")
        if emit:
            await emit("tts", {"stage": "tts", "status": "succeeded", "result": out})
        return out
    except Exception as e:  # noqa: BLE001
        await store.upsert_stage(job_id, "tts", 1, status="failed",
                                 finished_at=_now(), error=str(e))
        await store.update_job(job_id, status="failed", error=f"tts: {e}",
                               finished_at=_now())
        await store.add_event(job_id, "stage_finished", stage_key="tts",
                              level="error", message=str(e))
        raise


async def concat_narration(store: MonolineStore, ws: Workspace, job_id: UUID,
                           segs: list[dict]) -> Timings:
    """写 concat.txt → ffmpeg 无损拼接全片旁白 → 重算 timings 落库并回写段落。

    run_assemble（全链）与 recompose._reconcat（秒级重组）共用——同一份
    逻辑两处手写必然各自漂移（曾一样的块两边错误尾长度都不同步改）。
    """
    concat = ws.tts / "concat.txt"
    concat.write_text("".join(f"file '{s['wav_path']}'\n" for s in segs), encoding="utf-8")
    await run_ffmpeg(
        "ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
        "-c", "copy", str(ws.narration_wav),
    )
    timings = Timings.from_durations([s["text"] for s in segs],
                                     [float(s["tts_duration"]) for s in segs])
    (ws.ir / "timings.json").write_text(timings.model_dump_json(indent=2), encoding="utf-8")
    for sgm in timings.segments:
        await store.update_segment(job_id, sgm.i, start=sgm.start, end=sgm.end)
    await store.update_job(job_id, total_duration=timings.total)
    return timings


async def run_assemble(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                       cancel: asyncio.Event | None = None, emit=None) -> dict:
    """ffmpeg concat → narration.wav + timings.json + 起止回写（与上游 s_assemble 同语义）。"""
    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    if not segs or any(not s.get("wav_path") for s in segs):
        raise RuntimeError("assemble 需要先完成 tts（缺少逐拍 wav）")
    script = job.get("script_text") or ""
    voice = (segs[0].get("voice") or "") if segs else ""
    lang = (segs[0].get("lang") or "") if segs else ""
    speed = segs[0].get("speed") if segs else None
    ihash = _h(script, voice, lang, speed, TTS_INPUT_VERSION)

    prior = await store.get_stage(job_id, "assemble")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash
            and ws.narration_wav.exists()):
        if emit:
            await emit("assemble", {"stage": "assemble", "status": "skipped"})
        return {"skipped": True}

    await _check_cancel(store, job_id, cancel, "assemble")
    await store.upsert_stage(job_id, "assemble", 2, status="running",
                             started_at=_now(), input_hash=ihash)
    try:
        timings = await concat_narration(store, ws, job_id, segs)
        total = await _ffprobe_duration(ws.narration_wav)
        out = {"total": timings.total, "narration_bytes": ws.narration_wav.stat().st_size,
               "within_audio": abs(total - timings.total) < 0.12}
        await store.upsert_stage(job_id, "assemble", 2, status="succeeded",
                                 finished_at=_now(), output_json=out)
        await store.add_event(job_id, "stage_finished", stage_key="assemble", message="assemble")
        if emit:
            await emit("assemble", {"stage": "assemble", "status": "succeeded", "result": out})
        return out
    except Exception as e:  # noqa: BLE001
        await store.upsert_stage(job_id, "assemble", 2, status="failed",
                                 finished_at=_now(), error=str(e))
        await store.update_job(job_id, status="failed", error=f"assemble: {e}",
                               finished_at=_now())
        raise


def _write_hf_project(comp_dir: Path, job_id: UUID, name: str) -> None:
    """HyperFrames 工程脚手架（移植自上游 runner._write_hf_project，版本 pin 见 hf.HF_VERSION）。"""
    from .hf import HF_VERSION

    (comp_dir / "hyperframes.json").write_text(
        json.dumps({
            "$schema": "https://hyperframes.heygen.com/schema/hyperframes.json",
            "registry": "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry",
            "paths": {"blocks": "compositions", "components": "compositions/components",
                      "assets": "assets"},
            "media": {"autoProxy": True},
        }, indent=2), encoding="utf-8")
    (comp_dir / "meta.json").write_text(
        json.dumps({"id": job_id.hex, "name": name,
                    "createdAt": _now().isoformat()}), encoding="utf-8")
    (comp_dir / "package.json").write_text(
        json.dumps({"name": name, "private": True, "type": "module", "scripts": {
            "render": f"npx --yes hyperframes@{HF_VERSION} render"}}, indent=2),
        encoding="utf-8")


async def _guard(store: MonolineStore, job_id: UUID, key: str, seq: int, ihash: str,
                 cancel: asyncio.Event | None, emit=None) -> bool:
    """阶段前置：取消检查 + 运行态落库。返回 True=继续执行。"""
    await _check_cancel(store, job_id, cancel, key)
    await store.upsert_stage(job_id, key, seq, status="running",
                             started_at=_now(), input_hash=ihash)
    await store.add_event(job_id, "stage_started", stage_key=key, message=key)
    if emit:
        await emit(key, {"stage": key, "status": "running"})
    return True


async def _fail(store: MonolineStore, job_id: UUID, key: str, seq: int, exc: Exception,
                emit=None) -> None:
    await store.upsert_stage(job_id, key, seq, status="failed",
                             finished_at=_now(), error=str(exc))
    await store.update_job(job_id, status="failed", error=f"{key}: {exc}",
                           finished_at=_now())
    await store.add_event(job_id, "stage_finished", stage_key=key,
                          level="error", message=str(exc))
    if emit:
        await emit(key, {"stage": key, "status": "failed", "error": str(exc)})


async def _succeed(store: MonolineStore, job_id: UUID, key: str, seq: int, out: dict,
                   emit=None) -> dict:
    await store.upsert_stage(job_id, key, seq, status="succeeded",
                             finished_at=_now(), output_json=out)
    await store.add_event(job_id, "stage_finished", stage_key=key, message=key)
    if emit:
        await emit(key, {"stage": key, "status": "succeeded", "result": out})
    return out


async def _skipped(store: MonolineStore, job_id: UUID, key: str, emit=None) -> dict:
    await store.add_event(job_id, "stage_finished", stage_key=key, message="skipped (cached)")
    if emit:
        await emit(key, {"stage": key, "status": "skipped"})
    return {"skipped": True}


async def run_fonts(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                    cancel: asyncio.Event | None = None, emit=None) -> dict:
    """字形子集化（与上游 s_fonts 同语义；缺字 warn 不失败）。"""
    from backend.infrastructure.storage import file_store

    from .sceneplan import ScenePlan
    from .subset import collect_glyphs, subset_font

    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    plan_row = await store.get_plan(job_id)
    if plan_row is None:
        raise RuntimeError("fonts 需要先完成 plan（缺少分镜）")
    plan_json = plan_row["plan_json"]
    pj_hash = _h(json.dumps(plan_json, sort_keys=True, ensure_ascii=False))

    prior = await store.get_stage(job_id, "fonts")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == pj_hash
            and ws.font_woff2.exists()):
        return await _skipped(store, job_id, "fonts", emit)
    await _guard(store, job_id, "fonts", 4, pj_hash, cancel, emit)
    try:
        segs = await store.get_segments(job_id)
        plan = ScenePlan.model_validate(plan_json)
        texts = [s["text"] for s in segs] + [str(v) for sc in plan.scenes for v in _flat(sc.slots)]
        glyphs = collect_glyphs(texts, brand=plan.brand.label)
        cache_dir = file_store.data_dir / "models" / "fonts"
        res = await asyncio.to_thread(subset_font, glyphs, ws.font_woff2, cache_dir=cache_dir)
        shutil.copy(VENDOR_DIR / "fonts" / "OFL.txt", ws.comp_fonts / "LICENSE-OFL.txt")
        if res.missing:
            await store.add_event(
                job_id, "log", stage_key="fonts", level="warn",
                message=f"字体缺字 {len(res.missing)} 个，将由系统字体回退渲染（不影响出片）",
                data={"missing": res.missing[:12]})
        out = {"glyphs": res.glyphs, "bytes": res.bytes, "cached": res.cached,
               "missing": len(res.missing)}
        return await _succeed(store, job_id, "fonts", 4, out, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "fonts", 4, e, emit)
        raise


def _flat(d: dict) -> list:
    out = []
    for v in d.values():
        if isinstance(v, dict):
            out.extend(_flat(v))
        elif isinstance(v, list):
            out.extend(x for x in v if isinstance(x, str))
        elif isinstance(v, str):
            out.append(v)
    return out


async def run_compose(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                      cancel: asyncio.Event | None = None, emit=None) -> dict:
    """合成 index.html（DB plan 为准；与上游 s_compose 同语义）。"""
    from .audio_mix import ensure_voice_track
    from .compose import render_composition, vendor_composition_assets
    from .sceneplan import ScenePlan
    from .timings import Timings

    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    timings_path = ws.ir / "timings.json"
    if not timings_path.exists():
        raise RuntimeError("compose 需要先完成 assemble（缺少 timings）")
    plan_row = await store.get_plan(job_id)
    plan_src = plan_row["plan_json"] if plan_row else None
    if plan_src is None:
        raise RuntimeError("compose 需要先完成 plan（缺少分镜）")
    plan_json_str = json.dumps(plan_src, sort_keys=True, ensure_ascii=False)
    segs = await store.get_segments(job_id)
    av = _h(job.get("script_text") or "", (segs[0].get("voice") if segs else ""),
            (segs[0].get("lang") if segs else ""), (segs[0].get("speed") if segs else ""))
    bg = json.dumps(config.get("bgm"), sort_keys=True) if config.get("bgm") else ""
    density = config.get("density") or "standard"
    ihash = _h(plan_json_str, av, bg, density)

    prior = await store.get_stage(job_id, "compose")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash
            and ws.index_html.exists()):
        return await _skipped(store, job_id, "compose", emit)
    await _guard(store, job_id, "compose", 5, ihash, cancel, emit)
    try:
        timings = Timings.model_validate_json(timings_path.read_text(encoding="utf-8"))
        plan = ScenePlan.model_validate(plan_src)
        vo_src = await ensure_voice_track(ws, config, timings.total)
        html = await asyncio.to_thread(
            render_composition, timings, plan, title=job.get("title") or "",
            vo_src=vo_src, layout=config.get("layout", "minimal"),
            density=config.get("density") or "standard")
        ws.index_html.write_text(html, encoding="utf-8")
        await asyncio.to_thread(vendor_composition_assets, ws, VENDOR_DIR, html)
        await asyncio.to_thread(_write_hf_project, ws.composition, job_id,
                                job.get("title") or "monoline")
        await store.add_artifact(job_id, kind="composition_html", stage_key="compose",
                                 rel_path="composition/index.html", abs_path=str(ws.index_html),
                                 mime="text/html", size_bytes=ws.index_html.stat().st_size)
        return await _succeed(store, job_id, "compose", 5, {"html_bytes": len(html)}, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "compose", 5, e, emit)
        raise


async def run_gate(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                   cancel: asyncio.Event | None = None, emit=None,
                   hf: HF | None = None) -> dict:
    """hyperframes lint 门禁（与上游 s_gate 同语义；error 级即 fail）。"""
    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    if not ws.index_html.exists():
        raise RuntimeError("gate 需要先完成 compose（缺少 index.html）")
    comp_stage = await store.get_stage(job_id, "compose")
    ihash = (comp_stage or {}).get("input_hash") or ""

    prior = await store.get_stage(job_id, "gate")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash
            and (ws.gate / "lint.json").exists()):
        return await _skipped(store, job_id, "gate", emit)
    await _guard(store, job_id, "gate", 6, ihash, cancel, emit)
    try:
        ok, data = await (hf or HF()).lint(str(ws.composition))
        (ws.gate / "lint.json").write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        if not ok:
            raise RuntimeError(f"lint failed: {_lint_summary(data)}")
        return await _succeed(store, job_id, "gate", 6, {"lint": "pass"}, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "gate", 6, e, emit)
        raise


async def run_render(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                     cancel: asyncio.Event | None = None, emit=None,
                     hf: HF | None = None) -> dict:
    """HyperFrames CLI 渲染（CLI-first；Chrome 缺失快速失败，Setup 页置灰依据）。"""
    from .hf import chrome_available, resolve_node_bin

    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    canvas = job.get("canvas") or {}
    fmt = config.get("format", "mp4")
    slug = job.get("slug") or job_id.hex[:8]
    out = ws.renders / f"{slug}.{fmt}"

    comp_stage = await store.get_stage(job_id, "compose")
    ihash = _h((comp_stage or {}).get("input_hash") or "", fmt)
    prior = await store.get_stage(job_id, "render")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash
            and out.exists()):
        return await _skipped(store, job_id, "render", emit)
    if not ws.index_html.exists():
        raise RuntimeError("render 需要先完成 compose（缺少 index.html）")
    await _guard(store, job_id, "render", 7, ihash, cancel, emit)
    try:
        real_hf = hf or HF(node_bin=resolve_node_bin())
        if hf is None and not chrome_available():
            raise RuntimeError("Chrome headless 未就绪（data/models/browser 缺失）——"
                               "见 设置→文稿成片→环境自检")
        fps = int(canvas.get("fps", 30))
        quality = str(config.get("quality", "standard"))
        if emit:
            await emit("render", {"stage": "render", "status": "running",
                                  "message": f"启动 HyperFrames 渲染（CLI · {fmt}）…"})
        await real_hf.render(
            str(ws.composition), str(out), fps=fps, quality=quality, fmt=fmt)
        if emit:
            await emit("render", {"stage": "render", "status": "running",
                                  "message": f"渲染完成 → {out.name}"})
        return await _succeed(store, job_id, "render", 7,
                              {"video": str(out), "via": "cli", "format": fmt}, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "render", 7, e, emit)
        raise


async def run_deliver(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                      cancel: asyncio.Event | None = None, emit=None) -> dict:
    """ffprobe 校验 + 成片 artifact 登记（与上游 s_deliver 同语义）。"""
    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    canvas = job.get("canvas") or {}
    fmt = config.get("format", "mp4")
    slug = job.get("slug") or job_id.hex[:8]
    out = ws.renders / f"{slug}.{fmt}"
    if not out.exists():
        raise RuntimeError("deliver 需要先完成 render（缺少成片）")

    render_stage = await store.get_stage(job_id, "render")
    ihash = (render_stage or {}).get("input_hash") or ""
    prior = await store.get_stage(job_id, "deliver")
    if (prior and prior["status"] == "succeeded" and prior.get("input_hash") == ihash):
        return await _skipped(store, job_id, "deliver", emit)
    await _guard(store, job_id, "deliver", 8, ihash, cancel, emit)
    try:
        streams = await _ffprobe_streams(out)
        dur = await _ffprobe_duration(out)
        total = job.get("total_duration")
        if "audio" not in streams:
            raise RuntimeError("render has NO audio stream (silent video bug)")
        if total is not None and abs(dur - total) > 0.15:
            raise RuntimeError(f"render duration {dur} != narration {total}")
        await store.add_artifact(job_id, kind="render_mp4", stage_key="deliver",
                                 rel_path=f"renders/{out.name}", abs_path=str(out),
                                 mime=_MIME.get(fmt, "video/mp4"),
                                 size_bytes=out.stat().st_size, duration_seconds=dur,
                                 fps=int(canvas.get("fps", 30)),
                                 width=canvas.get("width"), height=canvas.get("height"))
        return await _succeed(store, job_id, "deliver", 8,
                              {"video": str(out), "duration": dur,
                               "streams": streams, "format": fmt}, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "deliver", 8, e, emit)
        raise


async def _ffprobe_streams(path: Path) -> list[str]:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0",
        str(path), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    return [ln.strip() for ln in out.decode().splitlines() if ln.strip()]


def keep_richer_plan(prior: dict | None, new_source: str, *, forced: bool = False) -> bool:
    """已存的人工/LLM 分镜是否必须在本轮存活（移植自上游 runner）。

    manual 永不重写（审稿的意义）；forced 显式重建可重做机器分镜；否则仅当
    新结果非 llm 而旧结果是 llm 时保留旧版——重跑不许把画面改差。
    """
    if not prior:
        return False
    src = prior.get("source")
    if src == "manual":
        return True
    if forced:
        return False
    return src == "llm" and new_source != "llm"


def _slug(text: str, n: int = 24) -> str:
    keep = [c if c.isalnum() else "-" for c in (text or "").lower()]
    s = "".join(keep).strip("-")
    s = "-".join(filter(None, s.split("-")))
    return s[:n] or "untitled"


# R5 破格位阈值：statement 连播达到此长度，强制升级其中一拍。
BREAKOUT_RUN_LENGTH = 4


async def _breakout_long_run(ai, beats: list[str], scenes: list[dict], *, model: str,
                             log=None) -> int | None:
    """最长 statement 连播段（≥阈值）取中点强制问模型，成功返回拍号，否则 None。

    每轮最多一次（预算封顶）；走 suggest() 故拍级缓存命中时零成本；
    落盘用 _clean_slots + tidy_slots 全套守卫，与 upgrade() 同口径。
    """
    from .display_text import tidy_slots
    from .llm_plan import _clean_slots

    best: list[int] = []
    cur: list[int] = []
    for i, sc in enumerate(scenes):
        if sc.get("kind") == "statement":
            cur.append(i)
        else:
            if len(cur) > len(best):
                best = cur
            cur = []
    if len(cur) > len(best):
        best = cur
    if len(best) < BREAKOUT_RUN_LENGTH:
        return None
    mid = best[len(best) // 2]
    verdict = await suggest(ai, beats[mid], scenes[mid], model=model)
    if verdict.get("status") != "changed":
        return None
    slots, why = _clean_slots(verdict.get("kind"), verdict.get("slots"), beats[mid])
    if slots is None:
        if log is not None:
            await log(f"破格第 {mid + 1} 拍被守卫拦下：{why}", level="warn")
        return None
    scenes[mid] = {"i": mid, "kind": verdict["kind"], "source": "llm:breakout",
                   "slots": tidy_slots(verdict["kind"], slots)}
    if log is not None:
        await log(f"破格：第 {mid + 1} 拍 statement 连播，强制换形→{verdict['kind']}")
    return mid


async def run_text(store: MonolineStore, ws_root: Path, job_id: UUID, *,
                   force: bool = False, llm_upgrade: bool = False, ai=None,
                   model: str = "default", batch_beats: int = 3, batch_chars: int = 900,
                   budget_seconds: float = 150.0,
                   cancel: asyncio.Event | None = None,
                   emit=None) -> dict:
    """script + plan 文本路径（上游 s_script + s_plan 的 Hertz 版）。

    - script hash 未变且两阶段成功态 → 整段 skipped（手工大纲/节拍原样保留，
      这正是审稿后运行不丢编辑的机制；service 之前无条件 outline.build 会覆盖，
      此处修复）；
    - manual 分镜（拍数一致）直接沿用，?force=1 也只重画不重写；
    - llm_upgrade 开启且非 manual 时走规则 + LLM 升格，keep_richer 防降级。
    """
    from .planner import RulePlanner, apply_icons, number_sections
    from .sceneplan import Canvas, ScenePlan, overlays_from_config
    from .segment import segment_text
    from .themes import resolve as resolve_theme
    from .workspace import Workspace

    ws = Workspace(ws_root).ensure()
    job = await store.get_job(job_id)
    if job is None:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    script = job.get("script_text") or ""
    script_hash = _h(script)
    plan_hash = _h(script, config.get("brand"), config.get("theme"), config.get("accent"))

    prior_script = await store.get_stage(job_id, "script")
    prior_plan = await store.get_stage(job_id, "plan")
    both_cached = (
        not force
        and prior_script and prior_script["status"] == "succeeded"
        and prior_script.get("input_hash") == script_hash
        and prior_plan and prior_plan["status"] == "succeeded"
        and prior_plan.get("input_hash") == plan_hash
    )
    if both_cached:
        await store.add_event(job_id, "stage_finished", stage_key="script",
                              message="skipped (cached)")
        await store.add_event(job_id, "stage_finished", stage_key="plan",
                              message="skipped (cached)")
        if emit:
            await emit("script", {"stage": "script", "status": "skipped"})
            await emit("plan", {"stage": "plan", "status": "skipped"})
        segs = await store.get_segments(job_id)
        plan_row = await store.get_plan(job_id)
        return {"beats": len(segs), "skipped": True,
                "source": (plan_row or {}).get("source", "")}

    await _check_cancel(store, job_id, cancel, "script")
    await store.upsert_stage(job_id, "script", 0, status="running",
                             started_at=_now(), input_hash=script_hash)
    try:
        beats = segment_text(script)
        if not beats:
            raise ValueError("script is empty")
        await store.replace_segments(
            job_id, [{"i": i, "text": t, "line_no": i + 1} for i, t in enumerate(beats)])
        slug = _slug(beats[0])
        await store.update_job(job_id, title=beats[0][:48], slug=slug)
        await store.upsert_stage(job_id, "script", 0, status="succeeded",
                                 finished_at=_now(),
                                 output_json={"beats": len(beats)})
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "script", 0, e, emit)
        raise

    await _check_cancel(store, job_id, cancel, "plan")
    await store.upsert_stage(job_id, "plan", 3, status="running",
                             started_at=_now(), input_hash=plan_hash)
    if emit:
        await emit("plan", {"stage": "plan", "status": "running"})
    try:
        prior = await store.get_plan(job_id)
        if prior and prior.get("source") == "manual":
            kept_scenes = (prior["plan_json"] or {}).get("scenes", [])
            if len(kept_scenes) == len(beats):
                await store.add_event(
                    job_id, "log", stage_key="plan", level="warn",
                    message="沿用大纲/Studio 的手动分镜（强制重跑只重画，不重写）")
                (ws.ir / "scene_plan.json").write_text(
                    json.dumps(prior["plan_json"], ensure_ascii=False, indent=2),
                    encoding="utf-8")
                kinds: dict[str, int] = {}
                for sc in kept_scenes:
                    kinds[sc.get("kind", "")] = kinds.get(sc.get("kind", ""), 0) + 1
                out = {"scenes": len(kept_scenes), "plan_version": prior["version"],
                       "kinds": kinds, "source": "manual:kept", "llm": {}}
                return await _succeed(store, job_id, "plan", 3, out, emit)
            await store.add_event(
                job_id, "log", stage_key="plan", level="warn",
                message=f"已存分镜 {len(kept_scenes)} 镜与当前 {len(beats)} 拍不符，按文稿重新分镜")
            prior = None

        theme = resolve_theme(config)
        scenes = RulePlanner().plan(beats, brand=config.get("brand", "Monoline"), script=script)
        source, llm = "rules", {}
        if llm_upgrade and ai is not None:
            from .llm_plan import upgrade

            try:
                scenes, llm = await upgrade(ai, beats, scenes, model=model,
                                            batch_beats=batch_beats, batch_chars=batch_chars,
                                            budget_seconds=budget_seconds)
                if llm.get("batches"):
                    await store.add_event(
                        job_id, "log", stage_key="plan",
                        message=f"逐批判定：{llm.get('asked', 0)} 拍分 {llm['batches']} 批，"
                                f"升格 {llm.get('upgraded', 0)} 拍，"
                                f"保持纯文字 {llm.get('declined', 0)} 拍"
                                + (f"；{llm['failed_batches']} 批失败按规则保留"
                                   if llm.get("failed_batches") else ""))
                apply_icons(scenes, beats)
                number_sections(scenes)
                source = "llm" if llm.get("upgraded") else "rules"
            except Exception as e:  # noqa: BLE001 — 升级失败不阻塞，规则保底
                await store.add_event(job_id, "log", stage_key="plan", level="warn",
                                      message=f"LLM 升格失败走规则：{e}")
                source = "rules"
        # R5 破格位：statement 连播 ≥4 时强制升级其中一拍（可控的意外）。
        # 仅一次、仅 llm_upgrade 开启时；suggest 自带拍级缓存，重复跑不重复付费。
        if llm_upgrade and ai is not None:
            try:
                broke = await _breakout_long_run(
                    ai, beats, scenes, model=model,
                    emit=lambda msg, **kw: store.add_event(
                        job_id, "log", stage_key="plan", **kw, message=msg))
                if broke is not None:
                    source = "llm"
            except Exception as e:  # noqa: BLE001 — 破格失败静默，规则保底
                await store.add_event(job_id, "log", stage_key="plan", level="warn",
                                      message=f"破格位跳过：{e}")
        if source != "llm" and keep_richer_plan(prior, source, forced=force):
            await store.add_event(
                job_id, "log", stage_key="plan", level="warn",
                message="本次没有 LLM 升格，沿用此前已生成的分镜（重跑不会把画面改差）")
            kept = prior["plan_json"]
            kept_scenes = kept.get("scenes", [])
            if len(kept_scenes) == len(beats):
                (ws.ir / "scene_plan.json").write_text(
                    json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
                kept_kinds: dict[str, int] = {}
                for sc in kept_scenes:
                    kept_kinds[sc.get("kind", "")] = kept_kinds.get(sc.get("kind", ""), 0) + 1
                out = {"scenes": len(kept_scenes), "plan_version": prior["version"],
                       "kinds": kept_kinds, "source": "llm:kept", "llm": llm}
                return await _succeed(store, job_id, "plan", 3, out, emit)

        plan = ScenePlan(job_id=job_id.hex, canvas=Canvas(**(job.get("canvas") or {})),
                         theme=theme, scenes=scenes, **overlays_from_config(config))
        warnings = plan.validate_against(len(beats))
        (ws.ir / "scene_plan.json").write_text(plan.model_dump_json(indent=2), encoding="utf-8")
        ver = await store.save_plan(job_id, plan.model_dump(mode="json"), source, warnings)
        kinds = {}
        for sc in scenes:
            kinds[sc["kind"]] = kinds.get(sc["kind"], 0) + 1
        out = {"scenes": len(beats), "plan_version": ver, "kinds": kinds,
               "warnings": warnings, "source": source, "llm": llm}
        return await _succeed(store, job_id, "plan", 3, out, emit)
    except Exception as e:  # noqa: BLE001
        await _fail(store, job_id, "plan", 3, e, emit)
        raise
