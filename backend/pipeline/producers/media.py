"""Producers — turn a downloaded item into a finished video (script → tts →
subtitles → edit → cover). Every producer is best-effort and idempotent:
it writes artifacts under ``output/pipeline/{item_id}/`` and returns a
small result dict for the produce step to persist on the item.
"""

import asyncio
import json
import logging
import re
from pathlib import Path

from backend.ai.router import AIRouter
from backend.config import settings
from backend.infrastructure.storage import FileStore
from backend.library.thumbnails import find_ffmpeg

logger = logging.getLogger(__name__)

# narration target: ~2.3 words/sec, narration covers ~52% of the clip
_WPS = 2.3
_RATIO = 0.52


class ProducerError(RuntimeError):
    """Raised when a producer cannot complete its artifact."""


def _artifacts_dir(files: FileStore, item) -> Path:
    # 锚定 data_dir（cwd 无关）：产物目录 = data/output/pipeline/<output_dir>/
    # output_dir 为结构化名（2026-08-04-01），与 download 步骤一致；旧数据兜底 hex
    slug = (item.output_dir or f"pipeline/{item.id.hex}").split("/")[-1]
    return files.output_root() / "pipeline" / slug


async def _run_cmd(cmd: list[str], *, timeout_s: int = 300) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except TimeoutError:
        proc.kill()
        raise ProducerError(f"command timed out after {timeout_s}s: {cmd[0]}") from None
    if proc.returncode != 0:
        tail = err.decode(errors="replace")[-500:]
        raise ProducerError(f"{cmd[0]} failed ({proc.returncode}): {tail}")
    return out


async def probe_duration(path: Path) -> float:
    """Media duration in seconds via ffprobe."""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return 0.0
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        data = json.loads(out.decode())
        return float(data.get("format", {}).get("duration") or 0.0)
    except (ValueError, json.JSONDecodeError):
        return 0.0


async def generate_script(ai: AIRouter, item) -> dict:
    """Script + metadata via the AI router; heuristic fallback if LLM is down."""
    content = f"{item.title}\n\n来源: r/{item.subreddit} (r/{item.subreddit})"
    text = ""
    try:
        text = await ai.script(content=content, title=item.title, max_words=120)
    except Exception:  # noqa: BLE001 — heuristic fallback
        logger.exception("script generation failed, using heuristic")
    if not text or len(text.strip()) < 20:
        text = (
            f"{item.title}。\n\n"
            f"这段内容来自 Reddit r/{item.subreddit} 的热门讨论，"
            "分享一个值得一看的瞬间。"
        )
    return {
        "mode": "script",
        "narration": text.strip(),
        "source": "llm" if text else "heuristic",
    }


def check_script_compliance(script: dict) -> dict:
    """合规门禁（Mojito heritage）：Tier1 违禁词阻断产出。"""
    from backend.pipeline.sensitive import check_script

    hits = check_script(script)
    if hits["tier1"]:
        raise ProducerError(
            f"content blocked by compliance check: {sorted(set(hits['tier1']))}"
        )
    return hits


async def synthesize_tts(ai: AIRouter, text: str, out_path: Path) -> dict:
    """TTS narration; raises ProducerError if TTS is unavailable.

    v3.0：音色由注册表 tts 角色决定（ai_roles.tts = provider:voice），
    TaskRouter.synthesize 解析；不再从 settings 直配。
    v0.2.7：文本参数化（旁白可能为翻译后的目标语言文本）。
    """
    if not ai.tts_available:
        raise ProducerError("TTS provider not configured")
    audio = await ai.synthesize(text[:1000])
    if not audio:
        raise ProducerError("TTS produced empty audio")
    await asyncio.to_thread(out_path.write_bytes, audio)
    return {"path": str(out_path), "bytes": len(audio)}


async def _localize_text(ai: AIRouter, text: str, target_lang: str) -> str:
    """旁白/字幕本地化（v0.2.7，参考原项目 locales）：LLM 翻译，失败回退原文。

    走 fast 角色（翻译是低成本任务，不占用 main 强推理）。
    """
    from backend.ai.types import ChatMessage

    if not text.strip():
        return text
    lang_names = {
        "en-US": "English", "zh-CN": "简体中文", "vi": "Tiếng Việt",
        "id": "Bahasa Indonesia", "fil": "Filipino", "pt-BR": "Português (Brasil)",
    }
    target = lang_names.get(target_lang, target_lang)
    messages = [
        ChatMessage(role="system", content=(
            "你是短视频旁白翻译。把文本翻译成"
            f"{target}，保持口语化、可直接朗读的节奏，"
            "不要解释、不要加引号，只输出译文。"
        )),
        ChatMessage(role="user", content=text),
    ]
    try:
        translated = await ai.chat_messages(messages, role="fast", max_tokens=1600)
        translated = (translated or "").strip()
        return translated if len(translated) >= 10 else text
    except Exception:  # noqa: BLE001 — 翻译失败回退原文，不阻塞生产
        logger.warning("localize to %s failed, falling back to original", target_lang)
        return text


def script_to_srt(
    text: str, duration: float, out_path: Path, start_offset: float = 0.0
) -> Path:
    """SRT：按句长加权分配时间（v0.3.0，参考原项目 _allocate_slots——
    长句多占时间，短句不硬撑；加旁白起始偏移），替代朴素均分。"""
    split_text = text.replace("。", "\n").replace(".", ".\n")
    sentences = [s.strip() for s in split_text.split("\n") if s.strip()]
    if not sentences:
        sentences = [text.strip()[:80]]
    # 权重：中文按字符数、英文按词数（长句长显示）
    weights = [
        max(len(s.split()), 1) if any(c.isascii() for c in s) else max(len(s), 1)
        for s in sentences
    ]
    total_w = sum(weights)
    usable = max(duration - start_offset, 0.0)
    lines: list[str] = []
    cursor = start_offset
    for i, (sentence, w) in enumerate(zip(sentences, weights, strict=False)):
        seg = usable * w / total_w
        # 最小可读时长 0.45s（参考原项目）
        seg = max(seg, 0.45)
        start = cursor
        end = min(start + seg, duration)
        cursor = end
        if end <= start:
            continue
        lines.append(f"{i + 1}\n{_fmt_ts(start)} --> {_fmt_ts(end)}\n{sentence[:120]}\n")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


def narration_start_offset(text: str, duration: float) -> float:
    """旁白起始延迟（v0.3.0，参考原项目 narration_start_seconds）：
    让画面先走一拍——开头 watch/look/see → 0.45s，slow/detail → 1.1s，
    默认 0.75s；封顶 min(2.2, dur*0.15)。
    """
    head = (text or "").strip().lower()[:80]
    if any(w in head for w in ("watch", "look", "see", "看", "今天")):
        offset = 0.45
    elif any(w in head for w in ("slow", "detail", "慢慢", "仔细")):
        offset = 1.1
    else:
        offset = 0.75
    return min(offset, max(duration * 0.15, 0.2), 2.2)


async def apply_narration_delay(audio_path: Path, offset: float) -> Path:
    """给旁白音频加起始静音（adelay），与字幕 start_offset 对齐（音画同步）。"""
    if offset <= 0:
        return audio_path
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return audio_path
    delayed = audio_path.with_name("narration-delayed.mp3")
    ms = int(offset * 1000)
    await _run_cmd([
        str(ffmpeg), "-y", "-i", str(audio_path),
        "-af", f"adelay={ms}|{ms}",
        "-c:a", "libmp3lame", "-q:a", "4",
        str(delayed),
    ])
    return delayed


def srt_to_ass(srt_path: Path, out_path: Path) -> Path:
    """SRT → ASS with fade-in/out (Autarkeia heritage: subtitles should feel
    alive, not hard-clipped). Keeps SRT timing, adds \fad(200,200).
    v0.4 B1：样式参数读配置（字号/描边/加粗/对齐），设置页可调。"""
    entries: list[tuple[int, int, str]] = []
    lines = srt_path.read_text(encoding="utf-8").splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)", lines[i])
        if m:
            h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
            text = "\\N".join(line.strip() for line in lines[i + 1 : i + 3] if line.strip())
            start_cs = (int(h1) * 3600 + int(m1) * 60 + int(s1)) * 100 + int(ms1) // 10
            end_cs = (int(h2) * 3600 + int(m2) * 60 + int(s2)) * 100 + int(ms2) // 10
            entries.append((start_cs, end_cs, text))
            i += 3
            continue
        i += 1
    font_size = int(getattr(settings, "pipeline_subtitle_font_size", 26))
    outline = int(getattr(settings, "pipeline_subtitle_outline", 2))
    bold = "-1" if getattr(settings, "pipeline_subtitle_bold", True) else "0"
    alignment = int(getattr(settings, "pipeline_subtitle_alignment", 2))
    header = (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,Noto Sans CJK SC,{font_size},&H00FFFFFF,&H00FFFFFF,"
        f"&H80000000,&H64000000,{bold},0,0,0,100,100,0,0,1,{outline},1,"
        f"{alignment},40,40,26,1\n\n[Events]\n"
        "Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = []
    for start_cs, end_cs, text in entries:
        if text:
            events.append(
                f"Dialogue: 0,{_fmt_ass_cs(start_cs)},{_fmt_ass_cs(end_cs)},"
                f"Default,,0,0,0,,{{\\fad(200,200)}}{text}"
            )
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_path


def _fmt_ass_cs(total_cs: int) -> str:
    h, r = divmod(total_cs, 360000)
    m, r = divmod(r, 6000)
    s, r = divmod(r, 100)
    return f"{h}:{m:02d}:{s:02d}.{r:02d}"


def _find_bgm() -> Path | None:
    """First audio file under data/assets/bgm (Autarkeia assets/media/bgm)."""
    import glob

    candidates = sorted(glob.glob(str(settings.data_dir / "assets" / "bgm" / "*.*")))
    for c in candidates:
        if c.lower().endswith((".mp3", ".wav", ".m4a", ".ogg")):
            return Path(c)
    return None


def _fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


async def compose_video(
    raw: Path, narration: Path | None, srt: Path | None, out: Path, *, muted: bool = False
) -> dict:
    """ffmpeg: 720p + ASS 淡入字幕 + 原声/旁白 ducking 混音 + 可选 BGM。

    音频策略（Autarkeia edit.py heritage）：旁白说话时原声压低
    （sidechaincompress），旁白静默时原声恢复；BGM 目录存在则铺底。
    v0.3.3：muted=True（静音模块）→ 跳过原声（无旁白则无音轨，有旁白只留旁白）。
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    out.parent.mkdir(parents=True, exist_ok=True)
    scale = "scale=1280:720:force_original_aspect_ratio=decrease"
    vf = [f"{scale},pad=1280:720:(ow-iw)/2:(oh-ih)/2"]
    subtitle_file = srt
    if srt is not None:
        ass = srt.with_suffix(".ass")
        try:
            await asyncio.to_thread(srt_to_ass, srt, ass)
            subtitle_file = ass
        except Exception:  # noqa: BLE001 — subtitles are best-effort
            subtitle_file = srt
        style = "FontSize=18,OutlineColour=&H80000000,Outline=1"
        vf.append(f"subtitles={subtitle_file.as_posix()}:force_style='{style}'")

    has_narration = narration is not None and await asyncio.to_thread(narration.exists)
    bgm = None if muted else _find_bgm()

    cmd = [ffmpeg, "-y", "-i", str(raw)]
    if has_narration:
        cmd += ["-i", str(narration)]
    if bgm is not None:
        cmd += ["-i", str(bgm)]
    cmd += ["-vf", ",".join(vf)]

    if muted:
        # 静音模块：丢弃原声；旁白存在则只留旁白轨，否则无音轨
        if has_narration:
            cmd += ["-map", "0:v", "-map", "1:a", "-c:a", "aac"]
        else:
            cmd += ["-map", "0:v", "-an"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast"]
    elif has_narration:
        # 原声 [0:a] 被旁白 [1:a] duck，再混旁白；BGM [2:a] 若有则铺底 0.10
        duck = (
            "[0:a]volume=1.0[bg];"
            "[bg][1:a]sidechaincompress=threshold=0.04:ratio=6:attack=40:release=500[ducked]"
        )
        if bgm is not None:
            mix = (
                f"{duck};[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=2[voice];"
                f"[2:a]volume=0.10[bgm];[voice][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]"
            )
        else:
            mix = f"{duck};[ducked][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]"
        cmd += ["-filter_complex", mix, "-map", "0:v", "-map", "[aout]"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
    elif bgm is not None:
        mix = "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]"
        cmd += ["-filter_complex", mix, "-map", "0:v", "-map", "[aout]"]
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy"]
    cmd.append(str(out))
    await _run_cmd(cmd)
    return {"path": str(out), "width": 1280, "height": 720}


async def _frame_interest(ffmpeg: str, probe_path: Path) -> float:
    """帧兴趣分（v0.3.0，参考原项目 cover.py）：signalstats 对比度（YSTD）
    为主分，暗/过曝（YAVG 越界）惩罚。返回 -1 = 不可评分。"""
    proc = await asyncio.create_subprocess_exec(
        str(ffmpeg), "-i", str(probe_path), "-vf",
        "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except TimeoutError:
        proc.kill()
        return -1.0
    ystd = yavg = None
    for line in out.decode(errors="replace").splitlines():
        m = re.search(r"YSTD=([\d.]+)", line)
        if m:
            ystd = float(m.group(1))
        m = re.search(r"YAVG=([\d.]+)", line)
        if m:
            yavg = float(m.group(1))
    if ystd is None:
        return -1.0
    score = ystd
    if yavg is not None:
        score -= max(0.0, 20.0 - yavg) * 0.2  # 暗画面惩罚
        score -= max(0.0, yavg - 235.0) * 0.2  # 过曝惩罚
    return score


async def generate_cover(raw: Path, out: Path) -> dict:
    """封面抽帧（v0.3.0，参考原项目 cover.py 兴趣评分）：
    5 位置采样（短片 3 个）→ 对比度/亮度评分取最高 → 16:9 裁切；
    全失败回退首帧，避免封面缺失。"""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    out.parent.mkdir(parents=True, exist_ok=True)
    duration = await probe_duration(raw)
    positions = [0.18, 0.32, 0.48, 0.62, 0.78] if duration >= 4 else [0.2, 0.5, 0.8]
    best_score = -1.0
    best_pct = 0.0
    probe_dir = out.parent / "cover-probes"
    await asyncio.to_thread(probe_dir.mkdir, exist_ok=True)
    for pct in positions:
        probe = probe_dir / f"p{int(pct * 100)}.jpg"
        try:
            await _run_cmd([
                str(ffmpeg), "-y", "-ss", str(max(duration * pct, 0.0)),
                "-i", str(raw), "-frames:v", "1",
                "-vf", "scale=160:90,format=yuv420p", str(probe),
            ])
        except Exception:  # noqa: BLE001 — 单位置失败跳过
            continue
        score = await _frame_interest(str(ffmpeg), probe)
        if score > best_score:
            best_score, best_pct = score, pct
        try:
            probe.unlink()
        except OSError:
            pass
    if best_score < 0:
        best_pct = 0.0  # 全部失败 → 首帧兜底
    await _run_cmd([
        str(ffmpeg), "-y", "-ss", str(max(duration * best_pct, 0.0)),
        "-i", str(raw), "-frames:v", "1",
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        str(out),
    ])
    return {"path": str(out)}


async def produce_item(
    ai: AIRouter, files: FileStore, item, existing_script: dict | None = None
) -> dict:
    """Full production for one item. Returns artifact dict; raises ProducerError
    only when no producible media exists (item-level failures). Individual
    artifact failures degrade gracefully (missing cover, subs-only, etc.).

    v0.2.7：existing_script 提供时（重新翻译）跳过脚本生成——只重跑
    TTS/字幕/合成，基于原视频重新翻译。
    v0.3.3：生产方式模块（item.produce_options）——直发/配音/字幕/翻译/静音
    按模块执行；直发跳过全部加工（原片即成片），仍抽封面 + phash。
    """
    opts = item.produce_options or {}
    passthrough = bool(opts.get("passthrough"))
    want_voice = bool(opts.get("voice"))
    want_subtitle = bool(opts.get("subtitle"))
    want_translate = bool(opts.get("translate"))
    muted = bool(opts.get("mute"))

    directory = _artifacts_dir(files, item)
    await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)

    raw_path = Path(files.resolve(item.raw_path)) if item.raw_path else None
    if raw_path is None or not raw_path.exists():
        raise ProducerError("raw media missing")

    # 直发（v0.3.3）：不加工——原片即产物（cover/phash 仍做，供审核与去重）
    if passthrough:
        artifacts: dict = {
            "script": None, "compliance": None, "directory": str(directory),
            "video": {"path": str(raw_path), "passthrough": True},
        }
        from backend.pipeline.phash import compute_phash

        artifacts["phash"] = await compute_phash(str(raw_path))
        cover_path = directory / "cover.jpg"
        try:
            artifacts["cover"] = await generate_cover(raw_path, cover_path)
        except ProducerError as exc:
            logger.warning("cover generation failed: %s", exc)
            artifacts["cover"] = None
        return artifacts

    script = existing_script or await generate_script(ai, item)
    compliance = check_script_compliance(script)
    artifacts = {"script": script, "compliance": compliance, "directory": str(directory)}

    # 处理语言（v0.2.7，参考原项目 locales）：英文旁白 + 中文字幕可配置；
    # v0.3.3：翻译模块 = 仅字幕翻译（原声保留）
    narration_text = str(script.get("narration") or "")[:1000]
    narration_lang = str(
        getattr(settings, "pipeline_narration_lang", "en-US") or "en-US"
    )
    subtitle_lang = str(
        getattr(settings, "pipeline_subtitle_lang", "zh-CN") or "zh-CN"
    )
    # 字幕文本：want_translate → 目标语言；否则原脚本中文
    subtitle_text = (
        narration_text
        if not want_translate or subtitle_lang == "zh-CN"
        else await _localize_text(ai, narration_text, subtitle_lang)
    )

    # 先探测原片时长（TTS 裁词预算依赖）
    duration = await probe_duration(raw_path)
    if duration <= 0:
        duration = 15.0  # unknown duration → fixed budget

    # 配音模块：旁白文本按 narration_lang 本地化（v0.2.7 语义）后 TTS 裁词重试；
    # 非配音模块 → 无旁白
    if want_voice:
        tts_text = (
            await _localize_text(ai, narration_text, narration_lang)
            if narration_lang != "zh-CN"
            else narration_text
        )
        audio_path = directory / "narration.mp3"
        tts = None
        current_text = tts_text
        for attempt in range(3):
            try:
                candidate = await synthesize_tts(ai, current_text, audio_path)
            except ProducerError as exc:
                logger.warning(
                    "tts attempt %d failed: %s", attempt + 1, exc
                )
                break
            audio_dur = await probe_duration(audio_path)
            if audio_dur and audio_dur <= duration * 0.98:
                tts = candidate
                break
            # 超预算：按比例裁词（保前段，≥4 字下限）
            ratio = max(0.3, (duration * 0.9) / max(audio_dur or duration, 1))
            current_text = current_text[: max(4, int(len(current_text) * ratio))]
            logger.warning(
                "narration %.1fs exceeds %.1fs budget — trim to %d chars, retry %d/3",
                audio_dur or 0, duration * 0.98, len(current_text), attempt + 2,
            )
        artifacts["audio"] = tts

        # 旁白起始延迟（v0.3.0）：音频加起始静音 + 字幕时间线同偏移
        start_offset = narration_start_offset(tts_text, duration)
        if artifacts.get("audio") is not None and start_offset > 0:
            try:
                delayed = await apply_narration_delay(
                    Path(artifacts["audio"]["path"]), start_offset
                )
                artifacts["audio"] = {"path": str(delayed), "bytes": artifacts["audio"]["bytes"]}
            except Exception:  # noqa: BLE001 — 延迟失败不影响主流程
                logger.warning("narration delay failed, continuing without offset")
    else:
        artifacts["audio"] = None
        start_offset = 0.0

    # 字幕模块：烧录字幕（不依赖旁白——subs-only 语义）
    srt_path = None
    if want_subtitle:
        srt_path = directory / "subs.srt"
        try:
            await asyncio.to_thread(
                script_to_srt, subtitle_text, duration, srt_path, start_offset
            )
            artifacts["subtitle"] = {"path": str(srt_path), "source": "script"}
        except Exception:  # noqa: BLE001 — subtitles are best-effort
            srt_path = None

    video_path = directory / "final.mp4"
    narration_file = Path(artifacts["audio"]["path"]) if artifacts.get("audio") else None
    try:
        edit = await compose_video(
            raw_path, narration_file, srt_path, video_path, muted=muted
        )
        artifacts["video"] = edit
    except ProducerError as exc:
        logger.warning("video composition failed: %s", exc)
        artifacts["video"] = None

    # phash 去重（v0.2.1，参考原项目 Autarkeia block_publish_duplicates）：
    # 成片平均哈希 → 发布闸门比对已发布条目
    if artifacts.get("video") is not None:
        from backend.pipeline.phash import compute_phash

        artifacts["phash"] = await compute_phash(str(video_path))
        if artifacts["phash"]:
            logger.debug("item phash=%s", artifacts["phash"])
    else:
        artifacts["phash"] = None

    cover_path = directory / "cover.jpg"
    try:
        artifacts["cover"] = await generate_cover(raw_path, cover_path)
    except ProducerError as exc:
        logger.warning("cover generation failed: %s", exc)
        artifacts["cover"] = None

    if artifacts.get("video") is None and artifacts.get("audio") is None:
        raise ProducerError("production produced no usable media")

    return artifacts
