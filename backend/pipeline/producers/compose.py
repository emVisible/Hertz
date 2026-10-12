"""视频合成域（v0.22.x B 系解体，自 media.py 迁出）。

职责单一：ffmpeg 合成引擎（字幕烧录三级降级/BGM 混音/narration ducking/
质量报告）+ BGM 资产发现 + libass 可用性探测。
不含：封面生成（cover.py）/ 故事合成（story.py）/ 片头前置（media.py）。

依赖纪律：仅 config/common/subtitles/probe/thumbnails——禁止回引 media。
"""

import asyncio
import logging
import tempfile
from pathlib import Path

from backend.config import settings
from backend.library.thumbnails import find_ffmpeg
from backend.pipeline.producers.common import ProducerError, _run_cmd
from backend.pipeline.producers.probe import probe_audio_duration, probe_duration
from backend.pipeline.producers.resolution import target_resolution
from backend.pipeline.producers.subtitles import (
    _subtitle_font,
    _wrap_lines,
    parse_srt_cues,
    srt_to_ass,
)

logger = logging.getLogger(__name__)

_subtitles_available: bool | None = None

def _find_bgm() -> Path | None:
    """First audio file under data/assets/bgm (Autarkeia assets/media/bgm)."""
    import glob

    candidates = sorted(glob.glob(str(settings.data_dir / "assets" / "bgm" / "*.*")))
    for c in candidates:
        if c.lower().endswith((".mp3", ".wav", ".m4a", ".ogg")):
            return Path(c)
    return None

async def subtitles_filter_available(ffmpeg: str) -> bool:
    """探测 ffmpeg 是否支持 subtitles/ass (libass) filter。

    v0.8.8：优先读 deps 缓存（启动/设置页手动检测，运行时零 subprocess）；
    缓存缺失（测试环境等）回退进程内探测。结果缓存于本模块。
    """
    global _subtitles_available
    if _subtitles_available is not None:
        return _subtitles_available
    from backend.infrastructure.deps import load_dependencies

    deps = load_dependencies()
    ff = (deps or {}).get("ffmpeg") or {}
    if "libass" in ff:
        _subtitles_available = bool(ff["libass"])
        return _subtitles_available
    try:
        proc = await asyncio.create_subprocess_exec(
            str(ffmpeg), "-filters",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        _subtitles_available = any(
            len(parts) >= 2 and parts[1] in ("subtitles", "ass")
            for line in out.decode(errors="replace").splitlines()
            if (parts := line.split())
        )
    except Exception:  # noqa: BLE001 — 探测失败按可用处理（沿用旧行为）
        _subtitles_available = True
    return _subtitles_available

def _render_cue_png(text: str, out_path: Path, size: tuple[int, int] | None = None) -> Path:
    """透明全帧 PNG 字幕（v0.9 对齐原项目 edit.py _render_cue_png）：
    白字单程描边（stroke_width，比 8 向叠加干净）、底部留白可配、
    最多 4 行——Homebrew ffmpeg 无 libass 时中文字幕烧录的降级通道。

    v0.11.2：字体/字号/描边/底部留白全部跟随设置（与 ASS 路径一致），
    描边用 PIL stroke_width 单程绘制（淡而细，不再 8 向重影）。

    v0.37：`size` 不传时取成片画幅。这张 PNG 要覆盖整帧，字号与边距是按
    成片像素算的——固定 1280×720 而成片是 1080p 时，PNG 会被拉伸，字幕
    位置随之偏移。
    """
    from PIL import Image, ImageDraw

    if size is None:
        size = target_resolution()[:2]
    font_size = int(getattr(settings, "pipeline_subtitle_font_size", 24))
    outline = int(getattr(settings, "pipeline_subtitle_outline", 1))
    margin_bottom = int(getattr(settings, "pipeline_subtitle_margin_bottom", 64))

    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _subtitle_font(font_size)
    max_w = size[0] - 120
    lines = _wrap_lines(text, font, max_w, draw)[:4]
    line_gap = 6
    heights: list[int] = []
    widths: list[int] = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        widths.append(bbox[2] - bbox[0])
        heights.append(bbox[3] - bbox[1])
    block_h = sum(heights) + line_gap * (len(lines) - 1)
    y = size[1] - margin_bottom - block_h
    stroke = max(1, outline)
    for line, w, h in zip(lines, widths, heights, strict=False):
        x = (size[0] - w) // 2
        draw.text(
            (x, y), line, font=font, fill=(255, 255, 255, 250),
            stroke_width=stroke, stroke_fill=(0, 0, 0, 150),
        )
        y += h + line_gap
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path

async def compose_video(
    raw: Path, narration: Path | None, srt: Path | None, out: Path,
    *, muted: bool = False, narr_start: float = 0.0, narr_dur: float = 0.0,
) -> dict:
    """ffmpeg 合成：成片画幅 + 字幕烧录三级降级 + 音频混流。

    字幕（v0.9 对齐原项目 edit.py）：libass（ASS 烧录）→ PNG overlay
    （透明 PNG 逐 cue 淡入淡出，规避无 libass 时中文乱码）→ 无字幕。

    音频（v0.9 对齐原项目 _audio_mix_filters）：时间窗口 duck（旁白
    区间原声压至 0.22，非 sidechain）、旁白轨 apad/atrim 防 amix 塌缩、
    amix normalize=0（不归一化）、统一 44100/fltp/stereo；特征无原声
    无旁白 → anullsrc 静音轨。合成后音频 < 视频 85% → 带 BGM 重混一次。
    v0.3.3：muted=True（静音模块）→ 跳过原声（无旁白则无音轨）。

    v0.37：输出尺寸不再写死 720p，取 `producers.resolution.target_resolution()`——
    它与 subtitles 的 ASS PlayResX/Y 同源，两者漂了就静默错位。
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    out.parent.mkdir(parents=True, exist_ok=True)
    target = await probe_duration(raw) or 0.0
    if target <= 0:
        raise ProducerError(f"cannot determine duration of {raw.name}")

    # 成片画幅（权威源：producers/resolution.py）
    w, h, fps = target_resolution()

    quality: dict = {"burn": "none", "audio_guard": "ok", "dropped": []}
    aformat = (
        "aresample=44100:async=1,"
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
    )

    with tempfile.TemporaryDirectory(prefix="hertz-compose-") as tmpd:
        tmp_dir = Path(tmpd)

        async def build_cmd(with_bgm: bool) -> list[str]:
            inputs: list[str] = ["-y", "-i", str(raw)]
            fc: list[str] = []
            next_idx = 1
            fc.append(
                f"[0:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p[base]"
            )
            current = "base"

            # 字幕烧录三级降级（v0.9 对齐原项目）：libass → PNG overlay → 无
            if srt is not None and await asyncio.to_thread(Path(srt).exists) and not muted:
                if await subtitles_filter_available(ffmpeg):
                    ass = Path(srt).with_suffix(".ass")
                    sub_file = Path(srt)
                    try:
                        await asyncio.to_thread(srt_to_ass, Path(srt), ass)
                        sub_file = ass
                    except Exception:  # noqa: BLE001 — subtitles are best-effort
                        pass
                    # v0.11.2：force_style 跟随设置（字号/描边），描边色弱化
                    style = (
                        f"FontSize={int(getattr(settings, 'pipeline_subtitle_font_size', 24))},"
                        f"Outline={int(getattr(settings, 'pipeline_subtitle_outline', 1))},"
                        "OutlineColour=&H66000000"
                    )
                    fc.append(
                        f"[{current}]subtitles={Path(sub_file).as_posix()}:"
                        f"force_style='{style}'[vsub]"
                    )
                    current = "vsub"
                    quality["burn"] = "ass"
                else:
                    try:
                        cues = parse_srt_cues(Path(srt))
                        overlay_done = False
                        for i, (start, end, text) in enumerate(cues):
                            start_t = max(0.0, start)
                            end_t = max(start_t + 0.2, end)
                            if start_t >= target:
                                continue
                            end_t = min(end_t, target)
                            png = tmp_dir / f"cue_{i:03d}.png"
                            _render_cue_png(text, png)
                            inputs += ["-loop", "1", "-t", str(target), "-i", str(png)]
                            dur = max(0.05, end_t - start_t)
                            fade_s = min(
                                int(getattr(settings, "pipeline_subtitle_fade_ms", 300)) / 1000.0,
                                dur / 3.0,
                            )
                            fi = fo = max(0.05, fade_s)
                            out_st = max(start_t, end_t - fo)
                            fc.append(
                                f"[{next_idx}:v]format=rgba,"
                                f"fade=t=in:st={start_t:.3f}:d={fi:.3f}:alpha=1,"
                                f"fade=t=out:st={out_st:.3f}:d={fo:.3f}:alpha=1,"
                                f"setpts=PTS-STARTPTS[sub{i}]"
                            )
                            fc.append(
                                f"[{current}][sub{i}]overlay=0:0:format=auto[vo{i}]"
                            )
                            current = f"vo{i}"
                            overlay_done = True
                            next_idx += 1
                        if overlay_done:
                            quality["burn"] = "overlay"
                        else:
                            quality["burn"] = "none"
                    except Exception:  # noqa: BLE001 — PNG 烧录失败降级无字幕
                        logger.exception("PNG subtitle burn failed — no burn-in")
                        quality["burn"] = "none"
                        if "subs_png" not in quality["dropped"]:
                            quality["dropped"].append("subs_png")

            has_narr_file = narration is not None and await asyncio.to_thread(
                narration.exists
            )
            narr_idx: int | None = None
            if has_narr_file and narr_dur > 0.05:
                inputs += ["-i", str(narration)]
                narr_idx = next_idx
                next_idx += 1

            bgm_idx: int | None = None
            if with_bgm:
                bgm = _find_bgm()
                if bgm is not None:
                    inputs += ["-stream_loop", "-1", "-i", str(bgm)]
                    bgm_idx = next_idx
                    next_idx += 1

            # 音频混流（v0.9 对齐原项目 _audio_mix_filters）
            parts: list[str] = []
            mix_labels: list[str] = []
            has_orig = (await probe_audio_duration(raw) or 0.0) > 0.0
            has_narr = narr_idx is not None and narr_dur > 0.05
            if not muted:
                if has_narr:
                    # 旁白轨 apad/atrim 防 amix 把输出塌缩成旁白长度
                    parts.append(
                        f"[{narr_idx}:a]{aformat},volume=1.05,"
                        f"apad=pad_dur={target},atrim=duration={target},"
                        f"asetpts=PTS-STARTPTS[narr]"
                    )
                    mix_labels.append("[narr]")
                if has_orig:
                    if has_narr:
                        narr_end = min(narr_start + max(narr_dur, 0.05), target)
                        if narr_end <= narr_start:
                            narr_end = narr_start + 0.05
                        vol = (
                            f"'if(between(t\\,{narr_start:.3f}\\,{narr_end:.3f})\\,"
                            f"0.22\\,1.0)'"
                        )
                        parts.append(f"[0:a]{aformat},volume={vol}:eval=frame[orig]")
                    else:
                        parts.append(f"[0:a]{aformat},volume=1.0[orig]")
                    mix_labels.append("[orig]")
                elif not has_narr:
                    parts.append(
                        f"anullsrc=channel_layout=stereo:sample_rate=44100,"
                        f"atrim=duration={target},asetpts=PTS-STARTPTS,{aformat}[silence]"
                    )
                    mix_labels.append("[silence]")
                if bgm_idx is not None:
                    parts.append(
                        f"[{bgm_idx}:a]{aformat},volume=0.08,"
                        f"atrim=duration={target},asetpts=PTS-STARTPTS[bgm]"
                    )
                    mix_labels.append("[bgm]")
                if len(mix_labels) == 1:
                    parts.append(f"{mix_labels[0]}anull[aout]")
                elif mix_labels:
                    parts.append(
                        "".join(mix_labels)
                        + f"amix=inputs={len(mix_labels)}:duration=longest:"
                          f"dropout_transition=0:normalize=0[aout]"
                    )

            cmd = [ffmpeg] + inputs + ["-filter_complex", ";".join(fc + parts)]
            if muted and not has_narr:
                cmd += ["-map", f"[{current}]", "-an"]
            elif muted:
                cmd += ["-map", f"[{current}]", "-map", f"{narr_idx}:a", "-c:a", "aac"]
            else:
                cmd += ["-map", f"[{current}]", "-map", "[aout]", "-c:a", "aac"]
            cmd += [
                "-c:v", "libx264", "-preset", "veryfast",
                "-movflags", "+faststart", str(out),
            ]
            return cmd

        await _run_cmd(await build_cmd(False))

        # 音频时长守卫（v0.9 对齐原项目 _probe_audio_duration 守卫）：
        # 输出音频 < 视频 85% → 带 BGM 重混一次；muted 无旁白预期无音轨不重试
        if not muted:
            out_audio = await probe_audio_duration(out)
            if out_audio and out_audio < target * 0.85:
                logger.warning(
                    "audio %.1fs < video %.1fs * 0.85 — re-mixing with BGM",
                    out_audio, target,
                )
                quality["audio_guard"] = "retried"
                await _run_cmd(await build_cmd(True))
                out_audio = await probe_audio_duration(out)
                if out_audio and out_audio < target * 0.85:
                    quality["dropped"].append("audio_short")

    return {
        "path": str(out), "width": w, "height": h,
        "quality": quality,
    }
