"""文字故事产线（v0.22.x B 系解体，自 media.py 迁出）：text_only 条目
渐变背景 + 中文旁白 + TTS + ASS 字幕合成。

依赖纪律：common 基建 / subtitles 工具 / config 直引；media 三个渲染/TTS
符号经函数级延迟导入（破环——media.produce_item 反向分派到本模块）。
"""

import asyncio
import logging
import re
from pathlib import Path

from backend.ai.router import AIRouter
from backend.config import settings
from backend.infrastructure.storage import FileStore
from backend.library.thumbnails import find_ffmpeg
from backend.models import script_keys as sk
from backend.pipeline.producers.common import (
    ProducerError,
    _raise_if_cancelled,
    _run_cmd,
)
from backend.pipeline.producers.probe import probe_audio_duration
from backend.pipeline.producers.subtitles import (
    _write_srt_cues,
    clean_zh_subtitle_text,
    srt_to_ass,
)

logger = logging.getLogger(__name__)

_STORY_GRADIENT = ((24, 20, 38), (58, 42, 74), (96, 64, 94))


def _render_story_bg(title: str, out: Path, *, credit: str = "") -> Path:
    """PIL 渐变背景 + 标题大字卡（1280x720，RGB）。"""
    from PIL import Image, ImageDraw

    w, h = 1280, 720
    img = Image.new("RGB", (w, h))
    px = img.load()
    top, mid, bot = _STORY_GRADIENT
    for y in range(h):
        t = y / (h - 1)
        if t < 0.5:
            f = t * 2
            c = tuple(int(top[i] + (mid[i] - top[i]) * f) for i in range(3))
        else:
            f = (t - 0.5) * 2
            c = tuple(int(mid[i] + (bot[i] - mid[i]) * f) for i in range(3))
        for x in range(w):
            px[x, y] = c
    draw = ImageDraw.Draw(img)
    from backend.pipeline.producers.media import _subtitle_font

    font = _subtitle_font(56)
    max_w = w - 160
    from backend.pipeline.producers.media import _wrap_lines

    lines = _wrap_lines(title, font, max_w, draw)[:3]
    y = 200
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        lw = bbox[2] - bbox[0]
        draw.text(((w - lw) // 2, y), line, font=font, fill=(255, 255, 255))
        y += (bbox[3] - bbox[1]) + 20
    # 分隔线 + 来源署名
    draw.line((w // 2 - 140, y + 6, w // 2 + 140, y + 6), fill=(255, 255, 255), width=2)
    if credit:
        from backend.pipeline.producers.media import _subtitle_font

        small = _subtitle_font(26)
        bbox = draw.textbbox((0, 0), credit, font=small)
        draw.text(((w - (bbox[2] - bbox[0])) // 2, y + 22), credit, font=small,
                  fill=(235, 220, 235))
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    return out


def _split_story_sentences(text: str) -> list[str]:
    """故事旁白断句：按句末标点切分（。！？…），超长硬折 22 字。"""
    cleaned = clean_zh_subtitle_text(text)
    if not cleaned:
        return []
    parts = re.split(r"(?<=[。！？…])\s*", cleaned)
    out: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if len(part) <= 22:
            out.append(part)
            continue
        for i in range(0, len(part), 22):
            piece = part[i : i + 22]
            if piece:
                out.append(piece)
    return out


def _story_cues(sentences: list[str], total_dur: float) -> list[tuple[float, float, str]]:
    """按字符比例把旁白时长分配到各句（对齐 TTS 朗读节奏的近似）。"""
    if not sentences:
        return []
    total_chars = max(1, sum(len(s) for s in sentences))
    cues: list[tuple[float, float, str]] = []
    t = 0.0
    for s in sentences:
        d = max(1.2, total_dur * len(s) / total_chars)
        cues.append((round(t, 2), round(min(t + d, total_dur + 0.3), 2), s))
        t += d
    if cues:
        last = cues[-1]
        cues[-1] = (last[0], round(max(last[1], total_dur), 2), last[2])
    return cues


async def _compose_story_video(
    bg: Path, audio: Path, ass: Path, out: Path, *, duration: float,
) -> dict:
    """ffmpeg 合成：背景图循环 + 旁白音频 + ASS 字幕烧录（libass）。"""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    style = (
        f"FontSize={int(getattr(settings, 'pipeline_subtitle_font_size', 24))},"
        f"Outline={int(getattr(settings, 'pipeline_subtitle_outline', 1))},"
        "OutlineColour=&H66000000"
    )
    vf = (
        f"scale=1280:720,subtitles={ass.as_posix()}:force_style='{style}'"
    )
    cmd = [
        str(ffmpeg), "-y",
        "-loop", "1", "-i", str(bg),
        "-i", str(audio),
        "-t", f"{max(duration, 0.5):.3f}",
        "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
        "-c:a", "aac", "-b:a", "160k",
        str(out),
    ]
    await _run_cmd(cmd)
    size_ok = await asyncio.to_thread(out.exists) and (
        await asyncio.to_thread(out.stat)
    ).st_size >= 1024
    if not size_ok:
        raise ProducerError("story compose failed: no output video")
    return {"burn": "ass", "mode": "story"}


async def produce_story_item(
    ai: AIRouter, files: FileStore, item,
    existing_script: dict | None = None,
) -> dict:
    from backend.pipeline.producers.media import _artifacts_dir
    from backend.pipeline.producers.narration import (
        check_script_compliance,
        synthesize_tts,
    )

    """文字故事帖 → 中文旁白 → TTS → 图文合成（v0.11.7）。

    产物：final.mp4（渐变背景 + 字幕烧录）/ narration.mp3 / subs.srt /
    cover.jpg（标题卡）。phash=None（无原始画面，去重靠标题指纹）。
    """
    from backend.pipeline.package import generate_packaging

    directory = _artifacts_dir(files, item)
    await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)

    content = (item.selftext or "").strip()[:6000]
    if len(content) < 20:
        content = f"{item.title}\n\n来源: r/{item.subreddit}"

    # 1. 中文故事旁白（LLM → heuristic 兜底）
    script = dict(existing_script or {})
    narration = str(script.get(sk.NARRATION) or "").strip()
    src = "existing" if narration else ""
    if not narration:
        try:
            narration = await ai.script(
                content=content, title=item.title, max_words=450, story=True,
            )
            src = "llm"
        except Exception:  # noqa: BLE001 — 旁白失败兜底，不阻塞生产
            logger.exception("story script generation failed, using heuristic")
        if not narration or len(narration.strip()) < 30:
            narration = clean_zh_subtitle_text(content)[:300] or item.title
            src = "heuristic"
    script["mode"] = "story"
    script[sk.NARRATION] = narration.strip()[:1200]
    script["source"] = src
    script[sk.CONTENT_SOURCE] = "selftext"
    _raise_if_cancelled()

    # 2. 合规（safety_only：安全红线阻断，营销极限词降级告警——中文旁白
    #    天然含「最/第一」等口语词，按广告法全量会误杀）
    compliance = check_script_compliance(script, safety_only=True)
    artifacts: dict = {
        "script": script, "compliance": compliance, "directory": str(directory),
        # 文字帖无原始画面：phash 无意义（去重靠标题指纹），显式置空
        "phash": None,
    }

    # 3. TTS 配音（固定中文女声 = IP 听觉标识；注册表手动配置优先）
    voice = "zh-CN-XiaoxiaoNeural"
    try:
        from backend.ai.registry import ProviderRegistry

        resolved = await ProviderRegistry().resolve_role("tts")
        configured = resolved["model_key"] if resolved else ""
        if configured and configured.lower() not in ("auto", "random", "smart"):
            voice = configured
    except Exception:  # noqa: BLE001 — 音色解析失败用默认
        pass
    audio_path = directory / "narration.mp3"
    tts = await synthesize_tts(ai, script[sk.NARRATION], audio_path, voice=voice)
    audio_dur = await probe_audio_duration(audio_path)
    if audio_dur <= 0:
        audio_dur = 60.0  # 探测失败 → 按默认 1 分钟兜底
    artifacts["audio"] = {"path": str(audio_path), "bytes": tts.get("bytes", 0)}
    _raise_if_cancelled()

    # 4. 字幕（中文旁白 → 断句 → 按字符比例对齐时长 → SRT → ASS）
    sentences = _split_story_sentences(script[sk.NARRATION])
    srt_path = directory / "subs.srt"
    _write_srt_cues(srt_path, _story_cues(sentences, audio_dur))
    ass_path = directory / "subs.ass"
    srt_to_ass(srt_path, ass_path)
    artifacts["subtitle"] = {"path": str(srt_path)}

    # 5. 背景 + 合成 + 封面
    bg_path = directory / "bg.png"
    credit = f"r/{item.subreddit}" if item.subreddit else ""
    await asyncio.to_thread(_render_story_bg, item.title, bg_path, credit=credit)
    final_path = directory / "final.mp4"
    _raise_if_cancelled()
    quality = await _compose_story_video(
        bg_path, audio_path, ass_path, final_path, duration=audio_dur,
    )
    artifacts["video"] = {"path": str(final_path), "quality": quality}
    cover_path = directory / "cover.jpg"
    await asyncio.to_thread(_render_story_bg, item.title, cover_path, credit=credit)
    artifacts["cover"] = {"path": str(cover_path)}

    # 6. B 站包装（标题/标签；简介 = 原帖标题，v0.11.5 语义）
    artifacts["script"] = await generate_packaging(ai, item, artifacts["script"])
    return artifacts


# ---- 栏目片头（v0.22 动态标题卡，非破坏性降级设计） ----
