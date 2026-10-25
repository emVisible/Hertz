"""Monoline 融合域端点：作业 CRUD + 大纲审阅 + 运行 + 事件流 + 元信息。

路径统一 `/api/monoline/*`（独立子域，不进 pipeline/studio 前缀）。
长任务走 MonolineService 单航班（409 busy）；进度经 EventHub SSE。
"""

import hashlib
import json
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from backend.factory.registry import ServiceRegistry
from backend.monoline.ffmpeg import run_ffmpeg

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/monoline", tags=["monoline"])


def _svc():
    return ServiceRegistry.get().monoline


def _uuid(job_id: str) -> uuid.UUID:
    try:
        return uuid.UUID(job_id)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"非法 job id：{job_id}") from None


@router.get("/status")
async def status():
    svc = _svc()
    return {"running": svc.running,
            "job_id": svc._current_id.hex if svc._current_id else None}  # noqa: SLF001


@router.get("/health")
async def health():
    """Setup 自检：Kokoro 权重/TTS/ffmpeg/音色数 + HyperFrames 渲染链（node/CLI/Chrome）。"""
    import shutil

    from backend.ai.providers.kokoro import KokoroProvider
    from backend.monoline.hf import HF_VERSION, chrome_available, node_major, resolve_node_bin

    try:
        node_bin = resolve_node_bin()
        node_ok = (node_major(node_bin) == 22)
    except Exception:  # noqa: BLE001 — 未找到 node 即自检项失败
        node_bin, node_ok = "", False
    return {
        "kokoro_status": KokoroProvider.status(),
        "kokoro_available": KokoroProvider.available(),
        "voices": len(KokoroProvider.voices()),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
        "node_bin": node_bin,
        "node_ok": node_ok,
        "hyperframes_version": HF_VERSION,
        "chrome_available": chrome_available(),
        "render_ready": bool(node_ok and chrome_available()),
    }


@router.post("/jobs")
async def create_job(body: dict):
    script = str(body.get("script") or "").strip()
    if not script:
        raise HTTPException(status_code=422, detail="script 必填")
    if len(script) > 200_000:
        raise HTTPException(status_code=422, detail="文稿过长（>200k 字符）")
    return await _svc().create_job(
        script, config=body.get("config") or {}, canvas=body.get("canvas") or {},
    )


@router.get("/jobs")
async def list_jobs(limit: int = Query(50, ge=1, le=200)):
    return {"jobs": await _svc().history(limit)}


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = await _svc().get_job(_uuid(job_id))
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    return job


@router.delete("/jobs/{job_id}")
async def delete_job(job_id: str):
    if not await _svc().delete_job(_uuid(job_id)):
        raise HTTPException(status_code=404, detail="job 不存在")
    return {"ok": True}


@router.post("/jobs/{job_id}/outline")
async def build_outline(job_id: str):
    try:
        return await _svc().build_outline(_uuid(job_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="job 不存在") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/jobs/{job_id}/outline")
async def get_outline(job_id: str):
    try:
        return await _svc().get_outline(_uuid(job_id))
    except KeyError:
        raise HTTPException(status_code=404, detail="job 不存在") from None


@router.patch("/jobs/{job_id}/outline")
async def apply_outline(job_id: str, body: dict):
    edits = body.get("entries") or body.get("edits") or []
    if not isinstance(edits, list):
        raise HTTPException(status_code=422, detail="entries 须为数组")
    try:
        return await _svc().apply_outline(_uuid(job_id), edits)
    except KeyError:
        raise HTTPException(status_code=404, detail="job 不存在") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/run")
async def run_job(job_id: str, force: bool = Query(False)):
    try:
        return await _svc().run(_uuid(job_id), force=force)
    except KeyError:
        raise HTTPException(status_code=404, detail="job 不存在") from None
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    return {"cancelled": _svc().cancel(_uuid(job_id))}


@router.get("/jobs/{job_id}/events")
async def list_events(job_id: str, limit: int = Query(500, ge=1, le=2000)):
    svc = _svc()
    if await svc.get_job(_uuid(job_id)) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    return {"events": await svc.store.list_events(_uuid(job_id), limit=limit)}


@router.get("/jobs/{job_id}/files/{rel_path:path}")
async def read_workspace_file(job_id: str, rel_path: str):
    """工作区文件（narration.wav / index.html 预览等），containment 检查防越界。"""
    from fastapi.responses import Response

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    root = svc.ws_root(jid).resolve()
    target = (root / rel_path).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(status_code=403, detail="拒绝越界路径")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    media = "audio/wav" if target.suffix == ".wav" else None
    if target.suffix == ".html":
        media = "text/html; charset=utf-8"
    data = target.read_bytes()
    return Response(content=data, media_type=media or "application/octet-stream")


@router.get("/themes")
async def list_themes():
    from backend.monoline.themes import available

    return {"themes": available()}


@router.get("/icons")
async def list_icons():
    """158 Lucide 内联图标清单（name + path body，供逐拍图标覆盖选择器）。"""
    from backend.monoline.icons import catalog

    icons = catalog()
    return {"icons": icons, "count": len(icons)}


@router.get("/brand/logo")
async def serve_brand_logo():
    """品牌 logo 文件流（无则 404，前端显示占位）。"""
    from fastapi.responses import FileResponse

    svc = _svc()
    brand = await svc.store.get_brand()
    name = brand.get("logo_name")
    path = svc.brand_dir() / name if name else None
    if path is None or not path.is_file():
        raise HTTPException(status_code=404, detail="未设置品牌 logo")
    media = "image/svg+xml" if path.suffix == ".svg" else None
    return FileResponse(path, media_type=media or "application/octet-stream")


@router.get("/voices")
async def list_voices():
    from backend.ai.providers.kokoro import KokoroProvider

    return {"voices": KokoroProvider.voices(), "default": "zf_xiaoxiao"}


@router.get("/presets")
async def list_presets():
    return {"presets": await _svc().store.list_presets()}


@router.post("/presets")
async def save_preset(body: dict):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name 必填")
    pid = await _svc().store.save_preset(name, body.get("config") or {})
    return {"id": str(pid)}


@router.delete("/presets/{preset_id}")
async def delete_preset(preset_id: str):
    try:
        pid = uuid.UUID(preset_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="非法 preset id") from None
    if not await _svc().store.delete_preset(pid):
        raise HTTPException(status_code=404, detail="preset 不存在")
    return {"ok": True}


async def _sse(topic: str):
    hub = ServiceRegistry.get().events

    async def stream():
        async with hub.subscribe(topic) as queue:
            yield "retry: 3000\n\n"
            while True:
                event = await queue.get()
                yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.get("/events")
async def monoline_events():
    """全局 monoline 主题 SSE（run_start/stage/run_done/outline）。"""
    return await _sse("monoline")


@router.get("/jobs/{job_id}/stream")
async def job_stream(job_id: str):
    """单作业 SSE。"""
    jid = _uuid(job_id)
    if await _svc().get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    return await _sse(f"monoline:{jid.hex}")


_SUB_MIME = {"srt": "application/x-subrip", "vtt": "text/vtt"}


def _disposition(slug: str, filename: str, inline: bool = False) -> str:
    """Starlette 按 latin-1 编码所有头值：回退名必须纯 ASCII，真实名走 RFC 5987。"""
    from urllib.parse import quote

    kind = "inline" if inline else "attachment"
    ext = filename[filename.rfind("."):] if "." in filename else ""
    return (f'{kind}; filename="download{ext}"; '
            f"filename*=UTF-8''{quote(f'{slug}{ext}')}")



@router.get("/jobs/{job_id}/download")
async def download_video(job_id: str):
    """成片 MP4 下载（render_mp4 artifact 定位；无成片 404）。"""
    from fastapi.responses import FileResponse

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    arts = await svc.store.list_artifacts(jid)
    mp4 = next((a for a in arts if a["kind"] == "render_mp4"), None)
    if mp4 is None or not mp4.get("rel_path"):
        raise HTTPException(status_code=404, detail="尚无成片，先运行作业")

    abs_path = svc.ws_root(jid).resolve() / mp4["rel_path"]
    if not abs_path.is_file():
        raise HTTPException(status_code=404, detail="成片文件缺失，请重跑 render")
    slug = job.get("slug") or jid.hex[:8]
    disp = _disposition(slug, f"{slug}.mp4")
    return FileResponse(abs_path, media_type="video/mp4",
                        headers={"Content-Disposition": disp})


@router.get("/jobs/{job_id}/subtitles")
async def download_subtitles(job_id: str, fmt: str = Query("srt")):
    """字幕边车（srt|vtt），由节拍时序实时生成，不落盘。"""
    from fastapi.responses import PlainTextResponse

    from backend.monoline.subtitles import to_srt, to_vtt

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    if fmt not in _SUB_MIME:
        raise HTTPException(status_code=422, detail=f"不支持的字幕格式 {fmt!r}")
    segs = await svc.store.get_segments(jid)
    if not segs:
        raise HTTPException(status_code=409, detail="尚无节拍，先运行作业")
    body = to_srt(segs) if fmt == "srt" else to_vtt(segs)
    slug = job.get("slug") or jid.hex[:8]
    return PlainTextResponse(body, media_type=_SUB_MIME[fmt],
                             headers={"Content-Disposition": _disposition(slug, f"sub.{fmt}")})


@router.get("/jobs/{job_id}/poster")
async def job_poster(job_id: str):
    """封面帧按需抽取（缓存 renders/poster.jpg，老作业自动回填）。"""

    from fastapi.responses import FileResponse

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    arts = await svc.store.list_artifacts(jid)
    mp4 = next((a for a in arts if a["kind"] == "render_mp4"), None)
    if mp4 is None:
        raise HTTPException(status_code=409, detail="尚无成片，先运行作业")

    root = svc.ws_root(jid).resolve()
    vid = root / (mp4.get("rel_path") or "")
    if not vid.is_file():
        raise HTTPException(status_code=404, detail="成片文件缺失，请重跑 render")
    out = root / "renders" / "poster.jpg"
    if not out.exists():
        total = float(job.get("total_duration") or 0.0)
        ts = min(1.2, total * 0.5) if total else 0.0  # 跳过开场黑淡入
        try:
            await run_ffmpeg("ffmpeg", "-v", "error", "-y", "-ss", f"{ts:.3f}", "-i", str(vid),
                             "-frames:v", "1", "-q:v", "2", str(out))
        except RuntimeError as exc:
            raise HTTPException(status_code=500, detail=f"封面抽取失败：{exc}") from None
        if not out.exists():  # rc=0 也不许静默空手而归
            raise HTTPException(status_code=500, detail="封面抽取失败：ffmpeg 未产出封面")
    slug = job.get("slug") or jid.hex[:8]
    return FileResponse(out, media_type="image/jpeg",
                        headers={"Content-Disposition": _disposition(slug, "poster.jpg",
                                                                     inline=True)})


@router.get("/voices/{voice_id}/sample")
async def voice_sample(voice_id: str):
    """音色试听 wav（data/cache/voice-sample 缓存；缺权重 502 明示）。"""
    from fastapi.responses import FileResponse

    from backend.ai.providers.kokoro import KokoroProvider
    from backend.infrastructure.storage import file_store
    from backend.monoline import voices as _voices

    if not _voices.is_known_voice(voice_id):
        raise HTTPException(status_code=404, detail=f"未知音色 {voice_id}")
    if not KokoroProvider.available():
        raise HTTPException(
            status_code=502,
            detail="Kokoro 权重未就绪（data/models/kokoro 缺失）——见 设置→文稿成片→环境自检")
    cache = file_store.data_dir / "cache" / "voice-sample"
    cache.mkdir(parents=True, exist_ok=True)
    out = cache / f"{voice_id}.wav"
    if not out.exists():
        line = _voices.sample_text(voice_id)
        data = await KokoroProvider().synthesize(line, voice_id)
        out.write_bytes(data)
    return FileResponse(out, media_type="audio/wav")


_ALLOWED_IMG = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
_MAX_IMG = 12 * 1024 * 1024
_ALLOWED_BGM = {".mp3", ".wav", ".m4a", ".ogg", ".flac"}
_MAX_BGM = 50 * 1024 * 1024
_ALLOWED_LOGO = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
_MAX_LOGO = 5 * 1024 * 1024


@router.post("/jobs/{job_id}/assets")
async def upload_asset(job_id: str, file: UploadFile = File(...)):  # noqa: B008    """图片冻入作业（composition/assets/<sha1-16>.<ext>；与 outline pin 形状一致）。"""
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    suffix = Path(file.filename or "img").suffix.lower()
    if suffix not in _ALLOWED_IMG:
        raise HTTPException(status_code=422, detail=f"不支持的图片类型 {suffix!r}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="空文件")
    if len(data) > _MAX_IMG:
        raise HTTPException(status_code=413, detail=f"图片过大（>{_MAX_IMG} bytes）")
    ws = Workspace(svc.ws_root(jid)).ensure()
    rel = f"assets/{hashlib.sha1(data).hexdigest()[:16]}{suffix}"
    (ws.composition / rel).write_bytes(data)
    return {"rel": rel, "bytes": len(data)}


@router.get("/jobs/{job_id}/assets")
async def list_assets(job_id: str):
    """已冻结图片/作业 logo 列表（composition/assets，供大纲挂图选择）。"""
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    comp_assets = Workspace(svc.ws_root(jid)).comp_assets
    out = []
    if comp_assets.is_dir():
        for f in sorted(comp_assets.iterdir()):
            if f.is_file() and f.suffix.lower() in _ALLOWED_IMG | {".svg"}:
                out.append({"rel": f"assets/{f.name}", "bytes": f.stat().st_size})
    return {"assets": out}


@router.post("/jobs/{job_id}/bgm")
async def upload_bgm(job_id: str, file: UploadFile = File(...),  # noqa: B008
                     volume: float = Form(0.22), duck: bool = Form(True)):
    """作业 BGM 挂载（替换同名旧轨；config.bgm 落库，下次运行 compose 即混音）。"""
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    suffix = Path(file.filename or "bgm").suffix.lower()
    if suffix not in _ALLOWED_BGM:
        raise HTTPException(status_code=422, detail=f"不支持的音频类型 {suffix!r}")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="空文件")
    if len(data) > _MAX_BGM:
        raise HTTPException(status_code=413, detail=f"音频过大（>{_MAX_BGM} bytes）")
    ws = Workspace(svc.ws_root(jid)).ensure()
    for old in ws.comp_audio.glob("bgm.*"):
        old.unlink(missing_ok=True)
    (ws.comp_audio / f"bgm{suffix}").write_bytes(data)
    config = dict(job.get("config") or {})
    config["bgm"] = {"src": f"audio/bgm{suffix}",
                     "volume": max(0.0, min(0.6, volume)), "duck": bool(duck)}
    await svc.store.update_job(jid, config=config)
    return {"bgm": config["bgm"]}


@router.delete("/jobs/{job_id}/bgm")
async def remove_bgm(job_id: str):
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    config = dict(job.get("config") or {})
    config.pop("bgm", None)
    await svc.store.update_job(jid, config=config)
    ws = Workspace(svc.ws_root(jid))
    if ws.comp_audio.exists():
        for old in ws.comp_audio.glob("bgm.*"):
            old.unlink(missing_ok=True)
    return {"removed": True}


@router.post("/jobs/{job_id}/logo")
async def upload_job_logo(job_id: str, file: UploadFile = File(...)):  # noqa: B008
    """作业级 logo 冻入（composition/assets/logo-*；分镜可用 image 槽引用）。"""
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    suffix = Path(file.filename or "logo").suffix.lower()
    if suffix not in _ALLOWED_LOGO:
        raise HTTPException(status_code=422, detail=f"不支持的 logo 类型 {suffix!r}")
    data = await file.read()
    if not data or len(data) > _MAX_LOGO:
        raise HTTPException(status_code=422, detail="空文件或过大（>5MB）")
    ws = Workspace(svc.ws_root(jid)).ensure()
    for old in ws.comp_assets.glob("logo-*"):
        old.unlink(missing_ok=True)
    rel = f"assets/logo-{hashlib.sha1(data).hexdigest()[:8]}{suffix}"
    (ws.composition / rel).write_bytes(data)
    return {"rel": rel, "bytes": len(data)}


@router.delete("/jobs/{job_id}/logo")
async def remove_job_logo(job_id: str):
    from backend.monoline.workspace import Workspace

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    ws = Workspace(svc.ws_root(jid))
    removed = False
    if ws.comp_assets.exists():
        for old in ws.comp_assets.glob("logo-*"):
            old.unlink(missing_ok=True)
            removed = True
    return {"removed": removed}


@router.get("/brand")
async def get_brand():
    return await _svc().store.get_brand()


@router.patch("/brand")
async def update_brand(body: dict):
    for key in ("label", "theme", "accent"):
        if key in body and not isinstance(body[key], (str, type(None))):
            raise HTTPException(status_code=422, detail=f"{key} 须为字符串")
    theme = body.get("theme")
    if theme:
        from backend.monoline.themes import available

        if theme not in [t["id"] for t in available()]:
            raise HTTPException(status_code=422, detail=f"未知主题 {theme}")
    return await _svc().store.save_brand(
        label=body.get("label"), theme=theme,
        accent=body.get("accent"), logo_name=body.get("logo_name"),
    )


@router.post("/brand/logo")
async def upload_brand_logo(file: UploadFile = File(...)):  # noqa: B008
    """品牌 logo 上传（存 brand 目录；建作业时自动冻入）。"""
    svc = _svc()
    suffix = Path(file.filename or "logo").suffix.lower()
    if suffix not in _ALLOWED_LOGO:
        raise HTTPException(status_code=422, detail=f"不支持的 logo 类型 {suffix!r}")
    data = await file.read()
    if not data or len(data) > _MAX_LOGO:
        raise HTTPException(status_code=422, detail="空文件或过大（>5MB）")
    for old in svc.brand_dir().glob("logo-*"):
        old.unlink(missing_ok=True)
    name = f"logo-{hashlib.sha1(data).hexdigest()[:8]}{suffix}"
    (svc.brand_dir() / name).write_bytes(data)
    return await svc.store.save_brand(logo_name=name)


@router.delete("/brand/logo")
async def remove_brand_logo():
    svc = _svc()
    for old in svc.brand_dir().glob("logo-*"):
        old.unlink(missing_ok=True)
    return await svc.store.save_brand(logo_name="")


@router.post("/brand/bgm")
async def upload_brand_bgm(file: UploadFile = File(...)):  # noqa: B008
    """品牌默认 BGM（存 brand_dir/bgm.*；新建作业自动挂载）。"""
    svc = _svc()
    suffix = Path(file.filename or "bgm").suffix.lower()
    if suffix not in _ALLOWED_BGM:
        raise HTTPException(status_code=422, detail=f"不支持的音频类型 {suffix!r}")
    data = await file.read()
    if not data or len(data) > _MAX_BGM:
        raise HTTPException(status_code=422, detail="空文件或过大（>50MB）")
    for old in svc.brand_dir().glob("bgm.*"):
        old.unlink(missing_ok=True)
    (svc.brand_dir() / f"bgm{suffix}").write_bytes(data)
    return {"src": f"bgm{suffix}", "bytes": len(data)}


@router.delete("/brand/bgm")
async def remove_brand_bgm():
    svc = _svc()
    removed = False
    for old in svc.brand_dir().glob("bgm.*"):
        old.unlink(missing_ok=True)
        removed = True
    return {"removed": removed}


@router.get("/brand/bgm")
async def brand_bgm_status():
    svc = _svc()
    names = sorted(p.name for p in svc.brand_dir().glob("bgm.*") if p.is_file())
    return {"src": names[0] if names else None}


def _recompose_hf():
    """逐拍编辑的 HF：service 注入优先（测试 FakeHF），否则真实。"""
    svc = _svc()
    hf = getattr(svc, "_hf", None)  # noqa: SLF001 — 与 status 端点同惯例
    if hf is not None:
        return hf
    from backend.monoline.hf import HF, resolve_node_bin

    try:
        return HF(node_bin=resolve_node_bin())
    except Exception:  # noqa: BLE001 — gate 阶段报错会写明缺 node
        return HF()


@router.patch("/jobs/{job_id}/segments/{i}")
async def patch_segment(job_id: str, i: int, body: dict):
    """改一拍旁白 → 单拍重 TTS → 重 concat/计时 → 关键词重提炼 → 重组。"""

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    from backend.monoline import recompose as recompose_mod

    text = str(body.get("text") or "")
    try:
        return await recompose_mod.resynth_segment(
            svc.store, svc.ws_root(jid), jid, i, text,
            tts_provider=await svc.tts_provider(), hf=_recompose_hf())
    except KeyError:
        raise HTTPException(status_code=404, detail="job 不存在") from None
    except IndexError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/jobs/{job_id}/segments/{i}/voice")
async def revoice_beat(job_id: str, i: int, body: dict):
    """单拍换音色（文本/关键词不动，该拍时长重测，全片重计时）。"""
    from backend.monoline import recompose as recompose_mod
    from backend.monoline import voices as _voices

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    voice = str(body.get("voice") or "")
    if not _voices.is_known_voice(voice):
        raise HTTPException(status_code=422, detail=f"未知音色 {voice!r}")
    try:
        return await recompose_mod.revoice_segment(
            svc.store, svc.ws_root(jid), jid, i, voice,
            tts_provider=await svc.tts_provider(), hf=_recompose_hf())
    except IndexError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/jobs/{job_id}/plan/scenes/{i}")
async def patch_scene(job_id: str, i: int, body: dict):
    """换一拍 kind/slots 并落盘（source=manual:studio）→ 秒级重组。"""
    from backend.monoline import recompose as recompose_mod
    from backend.monoline.sceneplan import KINDS

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    kind = body.get("kind")
    slots = body.get("slots")
    if kind is not None and kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"未知 kind {kind!r}")
    if slots is not None and not isinstance(slots, dict):
        raise HTTPException(status_code=422, detail="slots 须为对象")
    plan_row = await svc.store.get_plan(jid)
    if plan_row is None:
        raise HTTPException(status_code=409, detail="尚无分镜，先运行作业")
    plan = dict(plan_row["plan_json"])
    scenes = plan.get("scenes", [])
    if not (0 <= i < len(scenes)):
        raise HTTPException(status_code=422, detail=f"scene {i} 越界")
    if kind is not None:
        scenes[i]["kind"] = kind
        scenes[i]["source"] = "manual:studio"
    if slots is not None:
        if not slots:
            scenes[i]["slots"] = {}
        else:
            merged = dict(scenes[i].get("slots") or {})
            for k, v in slots.items():
                # null 值删键（如清掉 variant 回自动派发），其余合并
                if v is None:
                    merged.pop(k, None)
                else:
                    merged[k] = v
            scenes[i]["slots"] = merged
        scenes[i]["source"] = "manual:studio"
    ver = await svc.store.save_plan(jid, plan, "manual:studio", [])
    result = await recompose_mod.recompose(svc.store, svc.ws_root(jid), jid, hf=_recompose_hf())
    return {"version": ver, **result}


@router.post("/jobs/{job_id}/reorder")
async def reorder_beats(job_id: str, body: dict):
    """拖拽重排：order[p] 为新位置 p 上的 OLD 下标（音频跟随，无需重 TTS）。"""

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    order = body.get("order")
    if not isinstance(order, list) or not all(isinstance(x, int) for x in order):
        raise HTTPException(status_code=422, detail="order 须为整数数组")
    from backend.monoline import recompose as recompose_mod

    try:
        return await recompose_mod.reorder(svc.store, svc.ws_root(jid), jid, order,
                                             hf=_recompose_hf())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/voice")
async def revoice_job(job_id: str, body: dict):
    """全片换音色（lang 联动，重 TTS 全部节拍）。"""
    from backend.monoline import voices as _voices

    svc = _svc()
    jid = _uuid(job_id)
    if await svc.get_job(jid) is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    voice = str(body.get("voice") or "")
    if not _voices.is_known_voice(voice):
        raise HTTPException(status_code=422, detail=f"未知音色 {voice!r}")
    from backend.monoline import recompose as recompose_mod

    try:
        return await recompose_mod.revoice(svc.store, svc.ws_root(jid), jid, voice,
                               tts_provider=await svc.tts_provider(), hf=_recompose_hf())
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.patch("/jobs/{job_id}/config")
async def patch_job_config(job_id: str, body: dict):
    """换主题/外观（retheme）或语速（走 revoice 重 TTS）；其他键直接落库。"""
    from backend.monoline.themes import available

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    allowed = {"theme", "accent", "brand", "layout", "density", "speed", "format", "quality", "fps",
               "llm_plan", "llm_batch_beats", "llm_batch_chars", "llm_plan_seconds"}
    unknown = set(body) - allowed
    if unknown:
        raise HTTPException(status_code=422, detail=f"未知配置键 {sorted(unknown)}")
    if "theme" in body and body["theme"] not in [t["id"] for t in available()]:
        raise HTTPException(status_code=422, detail=f"未知主题 {body['theme']}")
    config = dict(job.get("config") or {})
    keys = set(body)
    config.update({k: v for k, v in body.items()})
    await svc.store.update_job(jid, config=config)
    from backend.monoline import recompose as recompose_mod

    if keys & {"theme", "accent", "brand", "layout", "density"}:
        return await recompose_mod.retheme(svc.store, svc.ws_root(jid), jid, hf=_recompose_hf())
    if "speed" in body:
        voice = config.get("voice") or "zf_xiaoxiao"
        return await recompose_mod.revoice(svc.store, svc.ws_root(jid), jid, voice,
                               tts_provider=await svc.tts_provider(), hf=_recompose_hf())
    return {"updated": sorted(keys)}


@router.post("/jobs/{job_id}/plan/upgrade")
async def upgrade_weak_beats(job_id: str):
    """弱拍一键问模型：规则分镜上只升格 statement 弱拍，结果落盘（source=llm）。"""
    from backend.monoline import llm_plan
    from backend.monoline.planner import apply_icons, number_sections

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    segs = await svc.store.get_segments(jid)
    if not segs:
        raise HTTPException(status_code=409, detail="尚无节拍，先审大纲")
    plan_row = await svc.store.get_plan(jid)
    if plan_row is None:
        raise HTTPException(status_code=409, detail="尚无分镜，先审大纲")
    ai, model = await svc.llm_target()
    if ai is None:
        raise HTTPException(status_code=502, detail="LLM 未配置（规则分镜不受影响）")
    beats = [s["text"] for s in segs]
    scenes = [dict(s) for s in (plan_row["plan_json"] or {}).get("scenes", [])]
    if len(scenes) != len(beats):
        raise HTTPException(status_code=409, detail="分镜与节拍数量不一致，先重审大纲")
    config = job.get("config") or {}
    try:
        scenes, stats = await llm_plan.upgrade(
            ai, beats, scenes, model=model,
            batch_beats=int(config.get("llm_batch_beats") or 3),
            batch_chars=int(config.get("llm_batch_chars") or 900),
            budget_seconds=float(config.get("llm_plan_seconds") or 150))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"升级失败：{exc}") from exc
    if stats.get("upgraded"):
        apply_icons(scenes, beats)
        number_sections(scenes)
        full = dict(plan_row["plan_json"] or {})
        full["scenes"] = scenes
        ver = await svc.store.save_plan(jid, full, "llm", [])
        stats["plan_version"] = ver
    return stats


@router.post("/jobs/{job_id}/plan/scenes/{i}/suggest")
async def suggest_scene(job_id: str, i: int):
    """单拍问模型换形状：只建议不落盘（changed/kept/rejected/unanswered 四态）。"""
    from backend.monoline import llm_plan

    svc = _svc()
    jid = _uuid(job_id)
    job = await svc.get_job(jid)
    if job is None:
        raise HTTPException(status_code=404, detail="job 不存在")
    segs = await svc.store.get_segments(jid)
    if not (0 <= i < len(segs)):
        raise HTTPException(status_code=422, detail=f"segment {i} 越界")
    plan_row = await svc.store.get_plan(jid)
    scenes = (plan_row["plan_json"] or {}).get("scenes", []) if plan_row else []
    scene = scenes[i] if 0 <= i < len(scenes) else {"kind": "statement", "slots": {}}
    ai, model = await svc.llm_target()
    if ai is None:
        raise HTTPException(status_code=502, detail="LLM 未配置，无法建议（规则分镜不受影响）")
    try:
        return await llm_plan.suggest(ai, segs[i]["text"], scene, model=model)
    except Exception as exc:  # noqa: BLE001 — 建议失败不抛 500，前端展示 unanswered
        logger.exception("suggest failed for job %s beat %d", jid.hex, i)
        return {"status": "unanswered", "kind": None, "slots": None, "model": model,
                "seconds": 0.0, "why": [], "error": str(exc)[:200], "cached": False}


@router.post("/script")
async def generate_script(body: dict):
    """AI 写稿（主题 → 文稿）：走 TaskRouter main；返回文稿 + 预估拍数。"""
    from backend.monoline.segment import segment_text

    topic = str(body.get("topic") or "").strip()
    if not topic:
        raise HTTPException(status_code=422, detail="topic 必填")
    if len(topic) > 2000:
        raise HTTPException(status_code=422, detail="topic 过长（>2000 字符）")
    tone = str(body.get("tone") or "neutral").strip() or "neutral"
    length = str(body.get("length") or "medium").strip() or "medium"
    ai, model = await _svc().llm_target()
    if ai is None:
        raise HTTPException(status_code=502, detail="LLM 未配置，无法写稿（可手工粘贴文稿）")
    system = ("你是短视频解说稿作者。输出可直接念的口播文稿：短句为主，每句一行，"
              "不要标题符号/列表符/markdown 修饰，不要寒暄和结语解释，只要正文。"
              "可画性要求（分镜能直接配图）：全篇至少包含一处数字锚点（如年份/数量/比例）、"
              "一处两两对照（如 A 与 B）、一处三步以上的做法或流程、一处时间先后线；"
              "数字与对照要写进句子里，不要单列成表。")
    hint = {"short": "约200字", "medium": "约500字", "long": "约1000字"}.get(length, "约500字")
    try:
        from backend.ai.types import ChatMessage

        text = await ai.chat_messages(
            [ChatMessage(role="system", content=system),
             ChatMessage(role="user",
                         content=f"主题：{topic}\n语气：{tone}\n篇幅：{hint}")],
            temperature=0.8, max_tokens=2048, caller="monoline-script")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"写稿失败：{exc}") from exc
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="模型返回空稿，请重试")
    beats = segment_text(text)
    return {"script": text, "beats": len(beats), "model": model}
