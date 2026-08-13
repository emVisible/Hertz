"""Producers — turn a downloaded item into a finished video (script → tts →
subtitles → edit → cover). Every producer is best-effort and idempotent:
it writes artifacts under ``output/pipeline/{item_id}/`` and returns a
small result dict for the produce step to persist on the item.
"""

import asyncio
import json
import logging
import re
import tempfile
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


async def probe_audio_duration(path: Path) -> float:
    """音频流时长（v0.8.9，对齐原项目 edit.py _probe_audio_duration）：
    ffprobe 首个音轨 (a:0) 的 stream duration——原声记录模式下字幕时间轴
    以「视频原声实际说话时长」为准（而非视频总时长，说话结束后画面还在
    继续时字幕不应继续铺）。无音轨/失败回退容器时长。
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return 0.0
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=duration", "-of", "json", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        streams = json.loads(out.decode()).get("streams") or []
        if streams and streams[0].get("duration"):
            return float(streams[0]["duration"])
    except (ValueError, json.JSONDecodeError):
        pass
    return await probe_duration(path)


def fit_script_to_budget(text: str, max_words: int) -> str:
    """按词数裁旁白（v0.8.9，对齐原项目 script.py fit_script_to_budget）：
    保句首、截断后补句号——比按字符比例截断更自然（不切断单词/句子）。"""
    words = (text or "").split()
    if max_words <= 0:
        return ""
    if len(words) <= max_words:
        return " ".join(words)
    trimmed = " ".join(words[:max_words]).rstrip(" .,;:!-")
    if trimmed and trimmed[-1] not in ".!?":
        trimmed += "."
    return trimmed


async def narration_budget(video_duration: float | None) -> dict:
    """旁白词数预算（v0.8.9，对齐原项目 script.py narration_budget）：
    2.3wps × 0.52 比例，短于此秒数/词预算过低 → 不生成旁白（字幕-only）。
    """
    dur = max(0.0, float(video_duration or 0.0))
    silent_below = float(getattr(settings, "pipeline_narration_silent_below", 8.0))
    min_words = int(getattr(settings, "pipeline_narration_min_words", 6))
    max_words_cap = int(getattr(settings, "pipeline_narration_max_words", 42))
    speak_sec = max(0.0, dur * max(0.15, min(_RATIO, 0.85)))
    max_words = min(max_words_cap, int(speak_sec * _WPS))
    if dur <= 0.5 or dur < silent_below or max_words < min_words:
        return {"mode": "subs_only", "max_words": 0}
    return {"mode": "voice", "max_words": max_words}


async def generate_script(
    ai: AIRouter, item, *, max_words: int = 120, video_duration: float | None = None
) -> dict:
    """Script + metadata via the AI router; heuristic fallback if LLM is down."""
    content = f"{item.title}\n\n来源: r/{item.subreddit} (r/{item.subreddit})"
    text = ""
    try:
        text = await ai.script(content=content, title=item.title, max_words=max_words)
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


async def synthesize_tts(
    ai: AIRouter, text: str, out_path: Path, *, voice: str | None = None
) -> dict:
    """TTS narration; raises ProducerError if TTS is unavailable.

    v3.0：音色由注册表 tts 角色决定（ai_roles.tts = provider:voice），
    TaskRouter.synthesize 解析；不再从 settings 直配。
    v0.2.7：文本参数化（旁白可能为翻译后的目标语言文本）。
    v0.8.9：voice 显式传入（pick_voice 内容自适应），rate 由配置 pipeline_tts_rate 透传。
    """
    if not ai.tts_available:
        raise ProducerError("TTS provider not configured")
    audio = await ai.synthesize(text[:1000], voice=voice or "")
    if not audio:
        raise ProducerError("TTS produced empty audio")
    await asyncio.to_thread(out_path.write_bytes, audio)
    return {"path": str(out_path), "bytes": len(audio)}


_LANG_NAMES = {
    "en-US": "English", "en-GB": "English (UK)", "zh-CN": "简体中文",
    "zh-TW": "繁體中文", "ja": "日本語", "ko": "한국어", "vi": "Tiếng Việt",
    "id": "Bahasa Indonesia", "fil": "Filipino", "pt-BR": "Português (Brasil)",
    "de": "Deutsch", "fr": "Français", "es": "Español", "ar": "العربية",
    "ru": "Русский", "it": "Italiano", "tr": "Türkçe", "th": "ภาษาไทย",
}


async def _localize_text(
    ai: AIRouter, text: str, target_lang: str, source_lang: str | None = None
) -> str:
    """旁白/字幕本地化（v0.2.7，参考原项目 locales）：LLM 翻译，失败回退原文。

    v0.8.9 翻译方向扩展：source_lang → target_lang 显式声明（默认源 =
    narration_lang，即 en→zh 保持现状）；目标语言任意可配（settings 页面下拉）。

    走 fast 角色（翻译是低成本任务，不占用 main 强推理）。
    """
    from backend.ai.types import ChatMessage

    if not text.strip():
        return text
    src = _LANG_NAMES.get(source_lang or "", "") or _LANG_NAMES.get(
        "en-US", "English"
    )
    target = _LANG_NAMES.get(target_lang, target_lang)
    messages = [
        ChatMessage(role="system", content=(
            "你是短视频旁白翻译。把"
            f"{src}文本翻译成{target}，保持口语化、可直接朗读的节奏，"
            "不要解释、不要加引号，只输出译文。\n"
            "烧录字幕要求：与原文句数一一对应（1 句原文 → 1 段译文），"
            "段间用单个空格分隔；译文内不要任何标点（。！？，、.!?）"
            "；禁止排比句、三段式口号、翻译腔长定语。"
        )),
        ChatMessage(role="user", content=text),
    ]
    try:
        translated = await ai.chat_messages(messages, role="fast", max_tokens=1600)
        translated = (translated or "").strip()
        return translated if len(translated.strip()) >= 4 else text
    except Exception:  # noqa: BLE001 — 翻译失败回退原文，不阻塞生产
        logger.warning(
            "localize %s→%s failed, falling back to original",
            source_lang or "?", target_lang,
        )
        return text


# 中文字幕清洗（v0.8.9，参考原项目 subtitle.py clean_zh_subtitle_text）：
# 烧录字幕去标点、句间单空格——避免标点符号挤占画面
_ZH_PUNCT_RE = re.compile(
    r"[。！？!?；;…‥，,、：:·•"
    r"“”\"'‘’「」『』（）\(\)【】\[\]《》〈〉<>"
    r"～~﹣－—–‐\-_/\\|@#$%^&*+=`]"
)
_SENT_SPLIT_RE = re.compile(r"[。！？!?；;…]+")


def clean_zh_subtitle_text(text: str) -> str:
    """去全部标点；保留句子边界为单空格（原项目 clean_zh_subtitle_text 移植）。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    if _SENT_SPLIT_RE.search(raw):
        cleaned: list[str] = []
        for part in _SENT_SPLIT_RE.split(raw):
            chunk = _ZH_PUNCT_RE.sub("", part)
            chunk = re.sub(r"\s+", "", chunk).strip()
            if chunk:
                cleaned.append(chunk)
        return " ".join(cleaned)
    chunk = _ZH_PUNCT_RE.sub("", raw)
    return re.sub(r"\s+", " ", chunk).strip()


def _split_zh_sentences(text: str) -> list[str]:
    """中文字幕断句（v0.8.9，对齐原项目 _split_zh_sentences）：
    清洗后按空格分段，每段 ≤22 字；超长按 18 字硬折行（无标点可拆）。"""
    cleaned = clean_zh_subtitle_text(text)
    if not cleaned:
        return []
    out: list[str] = []
    for part in [p for p in cleaned.split() if p]:
        if len(part) <= 22:
            out.append(part)
            continue
        for i in range(0, len(part), 18):
            piece = part[i : i + 18]
            if piece:
                out.append(piece)
    return out


def _split_en_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def _en_beat_weights(en_sentences: list[str]) -> list[float]:
    weights = [float(max(1, len(s.split()))) for s in en_sentences]
    return weights or [1.0]


def _join_cue_parts(parts: list[str]) -> str:
    joined = "".join(parts)
    if any("\u4e00" <= ch <= "\u9fff" for ch in joined):
        return joined
    return " ".join(parts)


def _fit_cues_to_beats(cues: list[str], n_beats: int) -> list[str]:
    """合并/拆分 cue 使数量与英文句数一致（1:1 时间线对齐，原项目移植）。"""
    n = max(1, int(n_beats))
    parts = [c.strip() for c in cues if c and c.strip()]
    if not parts:
        return [" "] * n
    if len(parts) == n:
        return parts
    if len(parts) > n:
        sizes = [max(1, len(p)) for p in parts]
        total = float(sum(sizes))
        target = total / n
        out: list[str] = []
        bucket: list[str] = []
        acc = 0.0
        for p, sz in zip(parts, sizes, strict=False):
            bucket.append(p)
            acc += sz
            if len(out) < n - 1 and acc >= target:
                out.append(_join_cue_parts(bucket))
                bucket = []
                acc = 0.0
        if bucket:
            out.append(_join_cue_parts(bucket))
        while len(out) < n:
            out.append(out[-1] if out else " ")
        return out[:n]
    out = list(parts)
    guard = 0
    while len(out) < n and guard < 64:
        guard += 1
        idx = max(range(len(out)), key=lambda i: len(out[i]))
        text = out[idx]
        if len(text) < 4:
            out.append(text)
            continue
        mid = max(1, len(text) // 2)
        out[idx : idx + 1] = [text[:mid], text[mid:]]
    while len(out) < n:
        out.append(out[-1] if out else " ")
    return out[:n]


def _allocate_slots(
    weights: list[float], total_dur: float, start_offset: float
) -> list[tuple[float, float]]:
    """绝对 [start, end) 槽位，总和精确等于 total_dur（无漂移，原项目移植）。"""
    wsum = sum(weights) or 1.0
    origin = max(0.0, float(start_offset or 0.0))
    span = max(0.5, float(total_dur))
    cursor = origin
    slots: list[tuple[float, float]] = []
    for i, w in enumerate(weights):
        if i == len(weights) - 1:
            end = origin + span
        else:
            end = cursor + span * (w / wsum)
        if end - cursor < 0.45 and i < len(weights) - 1:
            end = min(origin + span, cursor + 0.45)
        slots.append((cursor, end))
        cursor = end
    return slots


def script_to_srt(
    text: str,
    duration: float,
    out_path: Path,
    start_offset: float = 0.0,
    *,
    align_script: str | None = None,
) -> Path:
    """SRT：按句长加权分配时间（v0.3.0，参考原项目 _allocate_slots——
    长句多占时间，短句不硬撑；加旁白起始偏移），替代朴素均分。

    duration = 音频/时间轴实际时长（不含 start_offset——结尾 = offset + 时长，
    原项目语义）；voice 模式调用方传旁白音频实际时长（字幕跟声音同步）。

    v0.8.9 对齐原项目 subtitle.py：
    - 中文断句 _split_zh_sentences（≤22 字 + 18 字硬折行）
    - align_script：中文 cue 1:1 映射到英文 TTS beats（词数加权时间线，
      中文字幕与旁白同拍）；无 duration 时按每字估时（zh 0.18s / en 0.055s）
    """
    offset = max(0.0, float(start_offset or 0.0))
    timing_dur = float(duration) if duration and duration > 0.5 else 0.0
    is_zh = any("\u4e00" <= ch <= "\u9fff" for ch in (text or ""))

    en_align = (align_script or "").strip() if timing_dur > 0 else ""
    if en_align:
        en_beats = _split_en_sentences(en_align) or [en_align]
        zh_cues = _split_zh_sentences(text) if is_zh else [
            s for s in _split_en_sentences(text)
        ]
        if not zh_cues:
            zh_cues = [text.strip()[:80] or " "]
        cues = _fit_cues_to_beats(zh_cues, len(en_beats))
        weights = _en_beat_weights(en_beats)
        slots = _allocate_slots(weights, timing_dur, offset)
        return _write_srt(out_path, zip(cues, slots, strict=True))

    if is_zh:
        sentences = _split_zh_sentences(text)
        weights = [float(max(1, len(s))) for s in sentences]
    else:
        sentences = _split_en_sentences(text)
        weights = _en_beat_weights(sentences)
    if not sentences:
        sentences = [text.strip()[:80] or " "]
        weights = [1.0]

    if timing_dur > 0:
        slots = _allocate_slots(weights, timing_dur, offset)
        return _write_srt(out_path, zip(sentences, slots, strict=True))

    # 无音频长度：回退每字估时（zh 0.18s / en 0.055s，原项目同参）
    spc = 0.18 if is_zh else 0.055
    pairs: list[tuple[str, tuple[float, float]]] = []
    cursor = offset
    for sent in sentences:
        dur = max(1.0, min(5.5, len(sent) * spc))
        pairs.append((sent, (cursor, cursor + dur)))
        cursor += dur
    return _write_srt(out_path, pairs)


def _write_srt(out_path: Path, cues) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for i, (sent, (start, end)) in enumerate(cues, start=1):
        if end <= start:
            end = start + 0.4
        lines.append(str(i))
        lines.append(f"{_fmt_ts(start)} --> {_fmt_ts(end)}")
        lines.append(sent)
        lines.append("")
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


# libass 可用性缓存（v0.8.8）：ffmpeg 8.x 部分构建未编译 libass——
# subtitles filter 不存在时跳过烧录（保留 srt），生产降级不阻塞
_subtitles_available: bool | None = None


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


def _fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt_cues(srt_path: Path) -> list[tuple[float, float, str]]:
    """SRT → [(start_sec, end_sec, text), ...]（v0.8.9，对齐原项目）。"""
    text = srt_path.read_text(encoding="utf-8")
    blocks = re.split(r"\n\s*\n", text.strip())
    cues: list[tuple[float, float, str]] = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        timing = lines[1] if "-->" in lines[1] else (lines[0] if "-->" in lines[0] else None)
        if not timing:
            continue
        m = re.match(
            r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)",
            timing,
        )
        if not m:
            continue
        sh, sm, ss, sms, eh, em, es, ems = map(int, m.groups())
        start = sh * 3600 + sm * 60 + ss + sms / 1000.0
        end = eh * 3600 + em * 60 + es + ems / 1000.0
        body_lines = lines[2:] if "-->" in lines[1] else lines[1:]
        body = "\n".join(body_lines).strip()
        if body:
            cues.append((start, end, body))
    return cues


def _write_srt_cues(out_path: Path, cues: list[tuple[float, float, str]]) -> Path:
    """写 (start, end, text) cue 列表为 SRT（v0.8.9，对齐原项目 _write_srt）。"""
    lines: list[str] = []
    for i, (start, end, text) in enumerate(cues, 1):
        body = clean_zh_subtitle_text(text) or text.strip()
        lines.append(str(i))
        lines.append(f"{_fmt_ts(start)} --> {_fmt_ts(end)}")
        lines.append(body)
        lines.append("")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


_TRANSLATE_SUBS_SYSTEM = (
    """你是视频字幕翻译。把每段原文翻译成自然、简洁的{target}。段数必须完全一致。

Rules:
- 口语化、简洁——观众要快速读完
- 每段译文与对应原文段落一一对应（1:1），不增删内容
- 段内不要任何标点（。！？，、.!?），段间用空格拼接
- 只输出 JSON：{{"segments": ["翻译1", "翻译2", ...]}}"""
)

async def _translate_srt_cues(
    ai: AIRouter,
    cues: list[tuple[float, float, str]],
    target_lang: str = "zh-CN",
    batch_size: int = 20,
) -> list[tuple[float, float, str]]:
    """逐段 LLM 翻译字幕为 target_lang，保留时间戳（v0.8.9，对齐原项目
    _translate_srt_cues：batch 20、段数 1:1、失败回退原文不阻塞）。

    v0.8.9 翻译方向扩展：目标语言参数化（默认中文）；源语言由 ASR 检测
    /转写获得，prompt 不写死「英文→中文」。
    """
    from backend.ai.types import ChatMessage

    target = _LANG_NAMES.get(target_lang, target_lang)
    texts = [t for _, _, t in cues]
    result: list[str] = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        numbered = "\n".join(f"{j + 1}. {t}" for j, t in enumerate(batch))
        try:
            resp_text = await ai.chat_messages(
                [
                    ChatMessage(
                        role="system",
                        content=_TRANSLATE_SUBS_SYSTEM.format(target=target),
                    ),
                    ChatMessage(
                        role="user",
                        content=f"Translate these {len(batch)} subtitle segments:\n{numbered}",
                    ),
                ],
                role="fast",
                temperature=0.15,
                max_tokens=1600,
            )
            import json as _json

            try:
                resp = _json.loads((resp_text or "").strip() or "{}")
            except _json.JSONDecodeError:
                resp = {}
            trans = resp.get("segments") or []
            if len(trans) == len(batch):
                result.extend(trans)
            else:
                result.extend(batch)
        except Exception:  # noqa: BLE001 — 翻译失败回退原文
            result.extend(batch)
    return [(s, e, zh) for (s, e, _), zh in zip(cues, result, strict=True)]


async def probe_has_audio(path: Path) -> bool:
    """媒体是否含音轨（v0.8.9，对齐原项目 probe_has_audio）——ASR 前提。"""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return True
    ffprobe = str(Path(ffmpeg).with_name("ffprobe"))
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
        "stream=index", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return bool((out.decode(errors="replace") or "").strip())


async def _asr_subtitles(
    ai: AIRouter, raw_path: Path, directory: Path, target_lang: str = "zh-CN"
) -> tuple[Path, str] | None:
    """ASR 原声字幕（v0.8.9，对齐原项目 enable_asr/retranslate 第一步）：
    转写原声音轨（xinference 优先 / whisper 兜底）→ LLM 逐段翻译 →
    target_lang SRT（保留原声时间戳，字幕标点统一清洗）。返回 (srt, 译文
    全文)；任一环节失败返回 None。v0.8.9 翻译方向扩展：目标语言参数化。
    """
    from backend.pipeline.producers.asr import transcribe

    has_audio = await probe_has_audio(raw_path)
    if not has_audio:
        return None  # 图片帖等无原声——回退旁白翻译
    asr_srt = directory / "asr.srt"
    got = await transcribe(raw_path, asr_srt)
    if got is None:
        return None
    cues = parse_srt_cues(asr_srt)
    if not cues:
        return None
    zh_cues = await _translate_srt_cues(ai, cues, target_lang=target_lang)
    # v0.8.9 标点清洗（对齐原项目 _rewrite_srt_strip_zh_punct）：
    # ASR 译文可能残留标点，统一清洗（保留时间戳）
    zh_cues = [
        (s, e, clean_zh_subtitle_text(t) or " ")
        for s, e, t in zh_cues
    ]
    zh_srt = directory / "subs.srt"
    _write_srt_cues(zh_srt, zh_cues)
    full = " ".join(t for _, _, t in zh_cues).strip()
    return zh_srt, full


def _subtitle_font(size: int = 40):
    """PNG 烧录字幕字体（原项目 _subtitle_font 移植）：系统 CJK 字体优先。"""
    from PIL import ImageFont

    candidates = [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    ]
    for path in candidates:
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap_lines(text: str, font, max_width: int, draw) -> list[str]:
    """按像素宽折行（原项目 _wrap_lines 移植）。"""
    lines: list[str] = []
    for para in text.replace("\\N", "\n").splitlines() or [text]:
        current = ""
        for ch in para:
            trial = current + ch
            if draw.textlength(trial, font=font) <= max_width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = ch
        if current:
            lines.append(current)
    return lines or [text]


def _render_cue_png(text: str, out_path: Path, size: tuple[int, int] = (1280, 720)) -> Path:
    """透明全帧 PNG 字幕（v0.9 对齐原项目 edit.py _render_cue_png）：
    白字 8 向黑色描边、底部留白 56px、最多 4 行——Homebrew ffmpeg 无 libass
    时中文字幕烧录的降级通道。"""
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    font = _subtitle_font(40)
    max_w = size[0] - 120
    lines = _wrap_lines(text, font, max_w, draw)[:4]
    line_gap = 8
    heights: list[int] = []
    widths: list[int] = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        widths.append(bbox[2] - bbox[0])
        heights.append(bbox[3] - bbox[1])
    block_h = sum(heights) + line_gap * (len(lines) - 1)
    y = size[1] - 56 - block_h
    for line, w, h in zip(lines, widths, heights, strict=False):
        x = (size[0] - w) // 2
        for dx, dy in (
            (-2, 0), (2, 0), (0, -2), (0, 2),
            (-1, -1), (1, 1), (-1, 1), (1, -1),
        ):
            draw.text((x + dx, y + dy), line, font=font, fill=(0, 0, 0, 200))
        draw.text((x, y), line, font=font, fill=(255, 255, 255, 245))
        y += h + line_gap
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, "PNG")
    return out_path


async def compose_video(
    raw: Path, narration: Path | None, srt: Path | None, out: Path,
    *, muted: bool = False, narr_start: float = 0.0, narr_dur: float = 0.0,
) -> dict:
    """ffmpeg 合成：720p + 字幕烧录三级降级 + 音频混流。

    字幕（v0.9 对齐原项目 edit.py）：libass（ASS 烧录）→ PNG overlay
    （透明 PNG 逐 cue 淡入淡出，规避无 libass 时中文乱码）→ 无字幕。

    音频（v0.9 对齐原项目 _audio_mix_filters）：时间窗口 duck（旁白
    区间原声压至 0.22，非 sidechain）、旁白轨 apad/atrim 防 amix 塌缩、
    amix normalize=0（不归一化）、统一 44100/fltp/stereo；特征无原声
    无旁白 → anullsrc 静音轨。合成后音频 < 视频 85% → 带 BGM 重混一次。
    v0.3.3：muted=True（静音模块）→ 跳过原声（无旁白则无音轨）。
    """
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    out.parent.mkdir(parents=True, exist_ok=True)
    target = await probe_duration(raw) or 0.0
    if target <= 0:
        raise ProducerError(f"cannot determine duration of {raw.name}")

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
                "[0:v]scale=1280:720:force_original_aspect_ratio=decrease,"
                "pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p[base]"
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
                    style = "FontSize=18,OutlineColour=&H80000000,Outline=1"
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
                            fi = fo = min(0.2, dur / 3.0)
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
        "path": str(out), "width": 1280, "height": 720,
        "quality": quality,
    }


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
    # v0.9（AXIOM 26/34）：默认生产方式 = 翻译+字幕（无配音）——produce_options
    # 从未设置（None/{}）时不再退化为三无直发，与前端 DEFAULT_PRODUCE_OPTIONS 对齐。
    opts = dict(item.produce_options or {})
    opts.setdefault("voice", False)
    opts.setdefault("subtitle", True)
    opts.setdefault("translate", True)
    opts.setdefault("mute", False)
    passthrough = bool(opts.get("passthrough"))
    want_voice = bool(opts.get("voice"))
    want_subtitle = bool(opts.get("subtitle"))
    want_translate = bool(opts.get("translate"))
    muted = bool(opts.get("mute"))

    # v0.8.8（AXIOM 25/34）：先校验 raw 存在再建目录——此前 mkdir 在 raw
    # 校验之前，raw 缺失的失败会遗留空目录（测试曾积累 300+ 个 hex 空目录）
    raw_path = Path(files.resolve(item.raw_path)) if item.raw_path else None
    if raw_path is None or not raw_path.exists():
        raise ProducerError("raw media missing")

    directory = _artifacts_dir(files, item)
    await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)

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
        # 直发也补 B 站中文包装（v0.8.5）：发布元数据不依赖加工模式
        from backend.pipeline.package import generate_packaging

        script = await generate_packaging(
            ai, item, {"mode": "passthrough", "narration": ""}
        )
        artifacts["script"] = script
        return artifacts

    # v0.8.9 对齐原项目 narration_budget：先探测时长 → 按预算词数生成旁白
    duration = await probe_duration(raw_path)
    if duration <= 0:
        duration = 15.0  # unknown duration → fixed budget
    budget = await narration_budget(duration)

    script = existing_script or await generate_script(
        ai, item, max_words=budget["max_words"] or 120, video_duration=duration
    )
    # v0.8.9 迁移数据兜底：旧项目脚本（CandleBone 时代）只有 script 键无
    # narration——重制时旁白会变成字符串 "None" 烧进字幕。无 narration 时重生成
    if not str(script.get("narration") or "").strip():
        logger.warning("existing script lacks narration — regenerating")
        script = await generate_script(
            ai, item, max_words=budget["max_words"] or 120, video_duration=duration
        )
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
    # 翻译源语言（v0.8.9 方向扩展）：显式配置优先，空 = 沿用旁白语言
    translate_source = str(
        getattr(settings, "pipeline_translate_source_lang", "") or ""
    ).strip() or narration_lang
    # 字幕文本（v0.8.9 修复）：翻译模块 → 旁白本地化为 subtitle_lang（默认 zh-CN）。
    # 此前条件 `not want_translate or subtitle_lang == "zh-CN"` 把「目标语言是中文」
    # 误当「无需翻译」——默认配置下翻译永远不生效（英文旁白原样入字幕）。
    # 正确语义：源语言与目标字幕语言不同才需要翻译
    subtitle_text = (
        await _localize_text(
            ai, narration_text, subtitle_lang, source_lang=translate_source
        )
        if want_translate and translate_source != subtitle_lang
        else narration_text
    )
    # 中文字幕持久化（v0.8.5）：B 站简介构建复用（subtitle_zh 首句 + 署名）
    script["subtitle_zh"] = subtitle_text.strip()

    # 配音模块：旁白文本按 narration_lang 本地化（v0.2.7 语义）后 TTS 裁词重试；
    # 非配音模块 → 无旁白。v0.8.9：音色内容自适应（pick_voice）+ 语速（rate）
    if want_voice:
        # v0.9：配音文本来源可选——跟字幕译文配音（tts_text_source=subtitle）
        # 或跟旁白原文本地化配音（默认 script）
        tts_src = getattr(settings, "pipeline_tts_text_source", "script") or "script"
        if (tts_src == "subtitle" and want_translate and subtitle_text.strip()):
            tts_text = subtitle_text.strip()
        else:
            tts_text = (
                await _localize_text(ai, narration_text, narration_lang)
                if narration_lang != "zh-CN"
                else narration_text
            )
        # 音色（v0.8.9，对齐原项目 pick_voice）：注册表 tts 角色手动配置优先，
        # auto/未配置 → 内容自适应（tech→男声 / 暖心→女声 / 奇观男偏 + 随机）
        try:
            from backend.ai.registry import ProviderRegistry
            from backend.pipeline.producers.tts_voice import pick_voice

            resolved = await ProviderRegistry().resolve_role("tts")
            configured = resolved["model_key"] if resolved else ""
            if not configured or configured.lower() in ("auto", "random", "smart"):
                # v0.9 修复对齐走样：此前表达式恒 None（tags 从未传入内容匹配）
                voice, _reason = pick_voice(
                    title=item.title,
                    script=tts_text,
                    subreddit=item.subreddit or "",
                    tags=[
                        t.strip()
                        for t in str(script.get("bili_tags") or "").split(",")
                        if t.strip()
                    ],
                    configured="auto",
                )
            else:
                voice = configured
        except Exception:  # noqa: BLE001 — 音色解析失败用默认（角色配置）
            voice = ""
        audio_path = directory / "narration.mp3"
        tts = None
        audio_dur = 0.0
        current_text = tts_text
        for attempt in range(3):
            try:
                candidate = await synthesize_tts(
                    ai, current_text, audio_path, voice=voice or None
                )
            except ProducerError as exc:
                logger.warning(
                    "tts attempt %d failed: %s", attempt + 1, exc
                )
                break
            audio_dur = await probe_duration(audio_path)
            if audio_dur and audio_dur <= duration * 0.98:
                tts = candidate
                break
            # 超预算：按词数裁词（v0.8.9 对齐原项目 fit_script_to_budget，
            # 保句首、补句号——此前按字符比例截断会切断单词/句子）
            budget_words = max(4, int(len(current_text.split()) * max(
                0.3, (duration * 0.9) / max(audio_dur or duration, 1)
            )))
            trimmed = fit_script_to_budget(current_text, budget_words)
            if trimmed == current_text or not trimmed:
                logger.warning(
                    "narration %.1fs exceeds %.1fs budget — cannot trim further",
                    audio_dur or 0, duration * 0.98,
                )
                break
            current_text = trimmed
            logger.warning(
                "narration %.1fs exceeds %.1fs budget — trim to %d words, retry %d/3",
                audio_dur or 0, duration * 0.98, budget_words, attempt + 2,
            )
        artifacts["audio"] = tts

        # 旁白起始延迟（v0.3.0）：音频加起始静音 + 字幕时间线同偏移。
        # v0.8.9：tts_text 同步为最终合成文本（裁词后）——align_script /
        # start_offset 必须对准实际朗读的旁白而非未裁全文
        tts_text = current_text if tts is not None else tts_text
        start_offset = narration_start_offset(tts_text, duration)
        if tts is None:
            # v0.8.9 对齐原项目 _drop_to_subs_only：TTS 3 次仍超/无法裁 → 
            # 放弃配音转纯字幕（无旁白），否则旁白超出视频导致音画继续错位
            logger.warning(
                "TTS still exceeds video after retries — dropping to subs_only"
            )
            artifacts["audio"] = None
            audio_dur = 0.0
            start_offset = 0.0
        elif start_offset > 0:
            try:
                delayed = await apply_narration_delay(
                    Path(artifacts["audio"]["path"]), start_offset
                )
                artifacts["audio"] = {"path": str(delayed), "bytes": artifacts["audio"]["bytes"]}
            except Exception:  # noqa: BLE001 — 延迟失败不影响主流程
                logger.warning("narration delay failed, continuing without offset")
    else:
        artifacts["audio"] = None
        audio_dur = 0.0
        start_offset = 0.0

    # 字幕模块：烧录字幕（不依赖旁白——subs-only 语义）
    # v0.8.9 对齐原项目 enable_asr/retranslate：翻译且不配音时优先 ASR——
    # 提取视频原声 → 逐段中文字幕（保留原声时间戳，原声保留、无 TTS），
    # 即用户诉求的「提取视频原来的文字→转中文→打上字幕」；无原声/ASR
    # 失败自动回退旁白翻译（现状）
    srt_path = None
    asr_subtitle = None
    if want_subtitle:
        if (
            want_translate
            and not want_voice
            and bool(getattr(settings, "pipeline_enable_asr", True))
        ):
            try:
                asr_subtitle = await _asr_subtitles(
                    ai, raw_path, directory, target_lang=subtitle_lang
                )
            except Exception:  # noqa: BLE001 — ASR 失败回退旁白翻译
                logger.warning("ASR subtitles failed, falling back to narration subs")
            if asr_subtitle:
                srt_path, asr_text = asr_subtitle
                script["subtitle_zh"] = asr_text.strip()
                artifacts["subtitle"] = {"path": str(srt_path), "source": "asr"}
        if srt_path is None:
            srt_path = directory / "subs.srt"
            try:
                # v0.8.9 字幕同步（对齐原项目两个制作概念）：
                # 1. voice 模式：字幕时间轴 = 旁白音频实际时长（从 start_offset
                #    起，中文 cue 按英文 TTS beats 词数加权 1:1 对齐）
                # 2. 非 voice 模式（原声记录）：字幕时间轴 = 视频原声音频流的
                #    实际时长（probe_audio_duration）——说话者说完字幕即结束，
                #    不再铺满视频总时长；无音轨（图片帖/静音视频）回退视频时长
                if artifacts.get("audio") is not None:
                    timing_dur = min(
                        audio_dur or duration, max(0.5, duration - start_offset)
                    )
                else:
                    # 无音轨（图片帖/静音视频）时 probe_audio_duration 已
                    # 回退容器时长 → min(.., duration) = duration
                    timing_dur = min(
                        await probe_audio_duration(raw_path) or duration, duration
                    )
                await asyncio.to_thread(
                    script_to_srt, subtitle_text, timing_dur, srt_path, start_offset,
                    align_script=tts_text if artifacts.get("audio") is not None else None,
                )
                artifacts["subtitle"] = {
                    "path": str(srt_path),
                    "source": "asr" if asr_subtitle else "script",
                }
            except Exception:  # noqa: BLE001 — subtitles are best-effort
                srt_path = None

    video_path = directory / "final.mp4"
    narration_file = Path(artifacts["audio"]["path"]) if artifacts.get("audio") else None
    try:
        edit = await compose_video(
            raw_path, narration_file, srt_path, video_path, muted=muted,
            # v0.9 duck 窗口（对齐原项目 _audio_mix_filters）：旁白区间 =
            # start_offset ~ start_offset + 旁白实际时长；无 TTS 时为 0
            narr_start=start_offset,
            narr_dur=audio_dur,
        )
        artifacts["video"] = edit
    except ProducerError as exc:
        logger.warning("video composition failed: %s", exc)
        artifacts["video"] = None
        # v0.8.9 AXIOM 25：ffmpeg -y 失败可能残留半写文件——best-effort 清理
        try:
            await asyncio.to_thread(video_path.unlink, missing_ok=True)
        except OSError:
            pass

    # v0.8.9 AXIOM 4.6 末端兜底：合成彻底失败时用原片尽力交付——
    # 不伪装完整成功（degraded 标注进产物与 script_json），审核页可见来源
    if artifacts.get("video") is None:
        logger.warning(
            "composition failed — degrading to raw passthrough (AXIOM 4.6)"
        )
        artifacts["video"] = {
            "path": str(raw_path),
            "passthrough": True,
            "degraded": "raw",
        }
        script = dict(artifacts.get("script") or {})
        script["produced_degraded"] = "raw"
        artifacts["script"] = script

    # phash 去重（v0.2.1，参考原项目 Autarkeia block_publish_duplicates）：
    # 成片平均哈希 → 发布闸门比对已发布条目
    if artifacts.get("video") is not None:
        from backend.pipeline.phash import compute_phash

        phash_src = (
            video_path
            if artifacts["video"].get("passthrough") is not True
            else raw_path
        )
        artifacts["phash"] = await compute_phash(str(phash_src))
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

    # v0.9 成片质量落库（对齐原项目 compose_quality）：烧录方式/音频守卫/
    # 降级项进 script_json，审核卡可见（不静默降级）
    quality = dict((artifacts.get("video") or {}).get("quality") or {})
    if quality:
        script = dict(artifacts.get("script") or {})
        script["compose_quality"] = quality
        artifacts["script"] = script

    # B 站中文包装（v0.8.5，对齐原项目）：bili_title/bili_desc/bili_tags 自动补齐，
    # 发布卡可手动覆盖；LLM 失败 heuristic 兜底
    from backend.pipeline.package import generate_packaging

    artifacts["script"] = await generate_packaging(ai, item, artifacts["script"])

    return artifacts
