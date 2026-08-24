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
from backend.library.thumbnails import find_ffmpeg, find_ffprobe
from backend.pipeline.cancel import (
    ItemCancelledError,
    active_item,
    is_cancelled,
    reset_active_item,
    set_active_item,
)
from backend.pipeline.producers.subtitles import (  # noqa: F401 — 兼容旧引用面（asr/engine/tests 经 media.* 访问）
    _EN_LINE_WORDS,
    _FONT_NAMES,
    _LOCALIZE_LEAD_PUNCT,
    _SENT_SPLIT_RE,
    _ZH_PUNCT_RE,
    _allocate_slots,
    _en_beat_weights,
    _fit_cues_to_beats,
    _fmt_ass_cs,
    _fmt_ts,
    _join_cue_parts,
    _split_en_sentences,
    _split_zh_sentences,
    _translate_srt_cues,
    _write_srt,
    _write_srt_cues,
    clean_zh_subtitle_text,
    parse_srt_cues,
    script_to_srt,
    srt_to_ass,
    subtitle_font_family,
)

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


def _raise_if_cancelled() -> None:
    """协作式取消检查点（wave11）：命中即抛 ItemCancelledError 中止产线。

    读取 ContextVar 活动条目（produce_item 入口登记）——检查点无需
    透传 item_id 参数；无活动条目（测试直接调用/其他产线）时为空操作。
    ItemCancelledError 继承 Exception——但 produce 内所有 except Exception
    的降级分支都只会吞 ProducerError 等业务异常，检查点放在阶段之间，
    不会被误吞（各降级 try 块内部不设检查点）。
    """
    current = active_item()
    if current is not None and is_cancelled(current):
        raise ItemCancelledError(f"produce cancelled for item {current}")


async def _run_cmd(cmd: list[str], *, timeout_s: int = 300) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # 协作式取消（wave11）：0.25s 粒度轮询取消标志——命中即 terminate
        # （合成/转码是耗时大头，必须真杀进程才能省资源）
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while True:
            current = active_item()
            if current is not None and is_cancelled(current):
                if proc.returncode is None:
                    proc.terminate()
                out, err = await proc.communicate()
                raise ItemCancelledError(f"command cancelled: {cmd[0]}")
            remaining = deadline - loop.time()
            if remaining <= 0:
                proc.kill()
                raise ProducerError(f"command timed out after {timeout_s}s: {cmd[0]}") from None
            try:
                await asyncio.wait_for(proc.wait(), timeout=min(0.25, remaining))
                break
            except TimeoutError:  # asyncio.TimeoutError 是内建 TimeoutError 别名（ruff UP041）
                continue
        out, err = await proc.communicate()
    except TimeoutError:
        proc.kill()
        raise ProducerError(f"command timed out after {timeout_s}s: {cmd[0]}") from None
    if proc.returncode != 0:
        tail = err.decode(errors="replace")[-500:]
        raise ProducerError(f"{cmd[0]} failed ({proc.returncode}): {tail}")
    return out


async def probe_duration(path: Path) -> float:
    """Media duration in seconds via ffprobe."""
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return 0.0
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
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return 0.0
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
    ai: AIRouter, item, *, max_words: int = 120, video_duration: float | None = None,
    content: str | None = None,
) -> dict:
    """Script + metadata via the AI router; heuristic fallback if LLM is down.

    v0.11（内容源重构）：content = 视频原声转写文本（视频里说的话）——旁白
    基于视频内容生成；无转写（无音轨/ASR 不可用/失败）时回退标题+简介，
    content_source 标注实际数据源（transcript / metadata）。
    """
    body = (content or "").strip()
    if len(body) >= 20:
        script_source = "transcript"
    else:
        body = f"{item.title}\n\n来源: r/{item.subreddit} (r/{item.subreddit})"
        script_source = "metadata"
    text = ""
    try:
        text = await ai.script(
            content=body, title=item.title, max_words=max_words,
            task_id=f"item:{item.id}",
        )
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
        "content_source": script_source,
    }


def check_script_compliance(script: dict, *, safety_only: bool = False) -> dict:
    """合规门禁（Mojito heritage）：Tier1 违禁词阻断产出。
    v0.11.7：safety_only=True（故事旁白）→ 只按安全红线阻断，
    营销极限词降级 tier2 告警（中文旁白天然含「最/第一」等口语词）。"""
    from backend.pipeline.sensitive import check_script

    hits = check_script(script, safety_only=safety_only)
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



def _clean_nonzh_translation_text(text: str) -> str:
    """非中文译文清洗（v0.11.3）：去全部标点、保留词间距（与中文
    clean_zh_subtitle_text 的"去空格"语义不同——英文挤掉空格会糊成一片）；
    句边界（. ! ? …）折成单空格——script_to_srt 断句依赖。
    """
    parts = re.split(r"[.!?…]+", text)
    out: list[str] = []
    for part in parts:
        part = re.sub(
            r"[\"'“”‘’（）()\[\]{}<>，,、：:；;·•\-_—–~～@#$%^&*+=`|/\\]+",
            " ", part,
        )
        part = re.sub(r"\s+", " ", part).strip()
        if part and not part.isdigit():  # 编号残留（"1." → "1"）不落字幕
            out.append(part)
    return " ".join(out)


def _clean_translation_text(text: str) -> str:
    """翻译文本后置清洗（v0.11.2，v0.11.3 全语言化）：字幕不需要标点——

    - 去除句首/句尾标点（LLM 常在句首补“，”）
    - v0.11.3：任何语言译文一律去全部标点（用户诉求：翻译不带标点），
      句边界保留单空格（script_to_srt 断句依赖）
    """
    t = _LOCALIZE_LEAD_PUNCT.sub("", (text or "").strip())
    t = t.strip(" .,;:!?。！？…—")
    if not t:
        return ""
    if any("\u4e00" <= ch <= "\u9fff" for ch in t):
        return clean_zh_subtitle_text(t)
    return _clean_nonzh_translation_text(t)


_GLOSSARY_LIMIT = 100  # prompt 注入上限（updated_at 新者优先）



async def _localize_text(
    text: str, target_lang: str, source_lang: str | None = None,
) -> str:
    """旁白/字幕本地化——本地 Opus-MT en→zh 单步直翻（v0.22.x 去 API 化，D-189）。

    旧 LLM 三步法随翻译去 API 化整体移除；机翻质量对字幕场景够用
    （调研横评记 D-188）。语言对守卫：仅 en→zh 介入，其他对返回原文。
    失败语义不变：回退原文，不阻塞产线。
    """
    if not text.strip():
        return text
    if not ((source_lang or "").startswith("en") and target_lang == "zh-CN"):
        return text
    try:
        from backend.pipeline.producers.translate_engine import translate_local

        out = await translate_local(text)
        return _clean_translation_text(out) if out.strip() else _clean_translation_text(text)
    except Exception:  # noqa: BLE001 — 翻译失败回退原文，不阻塞生产
        logger.warning(
            "localize %s→%s failed — keeping original",
            source_lang or "?", target_lang,
        )
        return _clean_translation_text(text)

# 中文字幕清洗（v0.8.9，参考原项目 subtitle.py clean_zh_subtitle_text）：
# 烧录字幕去标点、句间单空格——避免标点符号挤占画面
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


async def probe_has_audio(path: Path) -> bool:
    """媒体是否含音轨（v0.8.9，对齐原项目 probe_has_audio）——ASR 前提。"""
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return True
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
        "stream=index", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return bool((out.decode(errors="replace") or "").strip())


async def _cues_already_target(cues, target_lang: str) -> bool:
    """转写文本已是目标语言则跳过 LLM 翻译（中文原声视频不绕一圈）。

    v0.10：翻译只对「原声非目标语言」发生——目标为中文且转写已含
    中文字符（≥3 字）时原文即目标语言，直接复用转写（省一次 LLM 调用）。
    """
    if not target_lang.lower().startswith("zh"):
        return False
    zh_count = sum(
        1
        for _, _, text in cues
        for ch in (text or " ")
        if "\u4e00" <= ch <= "\u9fff"
    )
    return zh_count >= 3


async def _asr_subtitles(
    ai: AIRouter,
    raw_path: Path,
    directory: Path,
    target_lang: str = "zh-CN",
    *,
    translate: bool = True,
    asr_srt: Path | None = None,
    task_id: str | None = None,
) -> tuple[Path, str] | None:
    """ASR 原声字幕（v0.8.9 起，v0.10 语义修正：字幕/翻译数据源 = 视频原声）：

    转写原声音轨（xinference 优先 / whisper 兜底）→ 可选 LLM 逐段翻译 →
    target_lang SRT（保留原声时间戳；translate=True 且目标为中文时译文标点
    统一清洗）。返回 (srt, 全文)；任一环节失败返回 None。
    translate=False：转写原文直接作字幕（原声语言），不翻译、不清洗。

    v0.11：asr_srt 传入时复用 produce 步骤的预转写结果（脚本生成已依赖
    转写全文，同一视频不转写两遍）。
    """
    from backend.pipeline.producers.asr import transcribe

    if asr_srt is None:
        has_audio = await probe_has_audio(raw_path)
        if not has_audio:
            return None  # 图片帖等无原声——回退旁白字幕
        asr_srt = directory / "asr.srt"
        got = await transcribe(raw_path, asr_srt)
        if got is None:
            return None
    cues = parse_srt_cues(asr_srt)
    if not cues:
        return None
    if translate and not await _cues_already_target(cues, target_lang):
        zh_cues = await _translate_srt_cues(cues, target_lang=target_lang)
        # v0.8.9 标点清洗（对齐原项目 _rewrite_srt_strip_zh_punct）：
        # ASR 译文可能残留标点，统一清洗（保留时间戳）
        zh_cues = [
            (s, e, clean_zh_subtitle_text(t) or " ")
            for s, e, t in zh_cues
        ]
    else:
        zh_cues = cues
    zh_srt = directory / "subs.srt"
    _write_srt_cues(zh_srt, zh_cues)
    full = " ".join(t for _, _, t in zh_cues).strip()
    return zh_srt, full


# 字幕字体（v0.11.2）：霞鹜文楷（LXGW WenKai，SIL OFL 1.1 免费商用）优先——
# data/assets/fonts/ 或系统字体目录（libass 经 fontconfig 按字体名匹配）；
# 缺字体回退 PingFang / Noto。优雅楷体，减轻 Noto Bold 的厚重感。
def _subtitle_font(size: int = 40):
    """PNG 烧录字幕字体（原项目 _subtitle_font 移植）：assets 霞鹜文楷优先。"""
    from PIL import ImageFont

    from backend.infrastructure.deps import font_file

    candidates: list[Path] = []
    ff = font_file()
    if ff is not None:
        candidates.append(ff)
    candidates += [
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
    白字单程描边（stroke_width，比 8 向叠加干净）、底部留白可配、
    最多 4 行——Homebrew ffmpeg 无 libass 时中文字幕烧录的降级通道。

    v0.11.2：字体/字号/描边/底部留白全部跟随设置（与 ASS 路径一致），
    描边用 PIL stroke_width 单程绘制（淡而细，不再 8 向重影）。
    """
    from PIL import Image, ImageDraw

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

    wave11 取消制作：入口登记活动条目（ContextVar）——产线内部检查点/
    _run_cmd 轮询据此查取消标志；收尾复位。无 id 的测试桩不受影响。
    """
    token = set_active_item(getattr(item, "id", None))
    try:
        artifacts = await _produce_item(ai, files, item, existing_script)
        # v0.22 栏目片头（非破坏性）：未绑定栏目/未启用/任一失败 → 原成片不变。
        # 单点汇聚挂钩——video_raw 与 story 两条产线的产物统一前置标题卡
        video = artifacts.get("video")
        if video and video.get("path"):
            try:
                from backend.pipeline.helpers import get_channel

                channel = await get_channel(getattr(item, "channel_key", None))
                if channel is not None and channel.intro_enabled():
                    video["path"] = await _prepend_channel_intro(
                        channel, Path(video["path"])
                    )
                    video["intro"] = True
            except ItemCancelledError:
                raise
            except Exception:  # noqa: BLE001 — 片头失败不阻塞生产（降级原成片）
                logger.warning(
                    "channel intro prepend failed — keep original video",
                    exc_info=True,
                )
        return artifacts
    finally:
        reset_active_item(token)


def _subtitle_cache_hit(
    existing_script, narration_text: str, src_lang: str, tgt_lang: str
) -> str | None:
    """字幕翻译缓存判定（v0.22.x）：narration 未变 + 译文已持久化 + 语言方向
    匹配 → 返回缓存译文；否则 None（走原翻译逻辑）。

    非破坏性：existing_script 为 None（打回重制）或键缺失 → None；
    「重新翻译」动作走 engine.retranslate 独立路径，不受此缓存影响。
    """
    if not isinstance(existing_script, dict):
        return None
    if str(existing_script.get("narration") or "").strip() != narration_text.strip():
        return None
    if existing_script.get("_sub_src") != src_lang or existing_script.get("_sub_tgt") != tgt_lang:
        return None
    cached = str(existing_script.get("subtitle_zh") or "").strip()
    return cached or None


async def _produce_item(
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
    # v0.11.9：默认生产方式 = 直发——produce_options 从未设置（None/{}）
    # 的新入库未加工条目原片直接发布（对齐前端 DEFAULT_PRODUCE_OPTIONS）；
    # 部分显式设置（如 voice+subtitle）保持 v0.9 语义（翻译+字幕兜底），
    # 不被直发劫持（此前 setdefault 顺序曾导致 voice/subtitle 与 passthrough 并存）。
    opts = dict(item.produce_options or {})
    if not opts:
        opts = {
            "passthrough": True, "voice": False,
            "subtitle": False, "translate": False, "mute": False,
        }
    else:
        opts.setdefault("voice", False)
        opts.setdefault("subtitle", True)
        opts.setdefault("translate", True)
        opts.setdefault("mute", False)
    passthrough = bool(opts.get("passthrough"))
    want_voice = bool(opts.get("voice"))
    want_subtitle = bool(opts.get("subtitle"))
    want_translate = bool(opts.get("translate"))
    muted = bool(opts.get("mute"))

    # v0.11.7 文字故事产线：text_only 帖无 raw 媒体，走独立分支
    # （selftext → 中文旁白 → TTS → 图文合成）
    if getattr(item, "item_type", "") == "text_only":
        return await produce_story_item(ai, files, item, existing_script)

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

    # v0.11 内容源 = 视频原声（视频里说的话）：生产任何内容之前先转写——
    # 旁白（script）、字幕、翻译、配音全部基于转写文本；无音轨（图片帖/
    # 静音视频）或 ASR 通道不可用/失败 → 回退标题+简介（content_source 标注）。
    transcript: dict | None = None
    if bool(getattr(settings, "pipeline_enable_asr", True)):
        try:
            if await probe_has_audio(raw_path):
                from backend.pipeline.producers.asr import transcribe

                asr_srt = directory / "asr.srt"
                got = await transcribe(raw_path, asr_srt)
                if got is not None:
                    cues = parse_srt_cues(asr_srt)
                    if cues:
                        transcript = {
                            "srt": asr_srt,
                            "cues": cues,
                            "text": " ".join(t for _, _, t in cues).strip(),
                        }
        except Exception:  # noqa: BLE001 — 转写失败不阻塞生产（回退简介）
            logger.warning("ASR transcription failed — falling back to metadata")
    _raise_if_cancelled()

    script = existing_script or await generate_script(
        ai, item, max_words=budget["max_words"] or 120, video_duration=duration,
        content=(transcript or {}).get("text"),
    )
    # v0.8.9 迁移数据兜底：旧项目脚本（CandleBone 时代）只有 script 键无
    # narration——重制时旁白会变成字符串 "None" 烧进字幕。无 narration 时重生成
    if not str(script.get("narration") or "").strip():
        logger.warning("existing script lacks narration — regenerating")
        script = await generate_script(
            ai, item, max_words=budget["max_words"] or 120, video_duration=duration,
            content=(transcript or {}).get("text"),
        )
    compliance = check_script_compliance(script)
    _raise_if_cancelled()
    artifacts = {
        "script": script, "compliance": compliance, "directory": str(directory),
    }
    if transcript:
        artifacts["transcript"] = {"path": str(transcript["srt"])}

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
    # v0.22.x 缓存复用：脚本未变且已有译文 → 跳过 LLM 翻译（省 3×token 三步法）
    cached_sub = _subtitle_cache_hit(
        existing_script, narration_text, translate_source, subtitle_lang
    )
    if want_translate and cached_sub is not None:
        subtitle_text = cached_sub
    elif want_translate and translate_source != subtitle_lang:
        subtitle_text = await _localize_text(
            narration_text, subtitle_lang, source_lang=translate_source,
        )
        if isinstance(script, dict):
            script["_sub_src"] = translate_source
            script["_sub_tgt"] = subtitle_lang
    else:
        subtitle_text = narration_text
    # 中文字幕持久化（v0.8.5）：B 站简介构建复用（subtitle_zh 首句 + 署名）
    script["subtitle_zh"] = subtitle_text.strip()

    # 字幕模块 · 原声字幕（v0.11：转写先行，复用预转写结果不重复转写）
    # v0.10 语义修正：字幕/翻译的数据源 = 视频原声（视频中的人说的话），
    # 旁白文案仅作回退——此前字幕基于简介派生的旁白文案，与用户语义
    # 「提取视频原话→（翻译→）字幕」不符：
    # - translate：原声转写 → 逐段翻译成 subtitle_lang（目标语言字幕）
    # - subtitle（无 translate）：原声转写原文（保留原声语言与时间戳）
    # - 原声缺失（图片帖/静音视频）/ ASR 通道不可用/失败 → 配音后回退旁白文案
    srt_path = None
    asr_subtitle = None
    if (
        want_subtitle
        and bool(getattr(settings, "pipeline_enable_asr", True))
    ):
        try:
            asr_subtitle = await _asr_subtitles(
                ai, raw_path, directory,
                target_lang=subtitle_lang, translate=want_translate,
                asr_srt=(transcript or {}).get("srt"),
                task_id=f"item:{item.id}",
            )
        except Exception:  # noqa: BLE001 — ASR 失败回退旁白字幕
            logger.warning("ASR subtitles failed, falling back to narration subs")
        if asr_subtitle:
            srt_path, asr_text = asr_subtitle
            script["subtitle_zh"] = asr_text.strip()
            artifacts["subtitle"] = {"path": str(srt_path), "source": "asr"}

    # 配音模块：旁白文本按 narration_lang 本地化（v0.2.7 语义）后 TTS 裁词重试；
    # 非配音模块 → 无旁白。v0.8.9：音色内容自适应（pick_voice）+ 语速（rate）
    if want_voice:
        # v0.9：配音文本来源可选——跟字幕译文配音（tts_text_source=subtitle）
        # 或跟旁白原文本地化配音（默认 script）
        # v0.11：subtitle 源 = script["subtitle_zh"]（转写译文优先，旁白文案兜底）
        tts_src = getattr(settings, "pipeline_tts_text_source", "script") or "script"
        subtitle_zh = str(script.get("subtitle_zh") or subtitle_text or "").strip()
        if (tts_src == "subtitle" and want_translate and subtitle_zh):
            tts_text = subtitle_zh
        else:
            # v0.22.x：脚本按 narration_lang 生成，旁白本就是目标语言——
            # 旧版此处对 en→en 的「本地化」为恒等调用，随去 API 化直接取旁白
            tts_text = narration_text
        # 音色（v0.8.9，对齐原项目 pick_voice）：注册表 tts 角色手动配置优先，
        # auto/未配置 → 内容自适应（tech→男声 / 暖心→女声 / 奇观男偏 + 随机）
        # v0.22 栏目固定音色：最高优先级——未绑定栏目时为 None，走原链（非破坏性）
        try:
            from backend.pipeline.helpers import get_channel

            _channel = await get_channel(getattr(item, "channel_key", None))
            channel_voice = (_channel.voice or "").strip() if _channel else ""
            from backend.ai.registry import ProviderRegistry
            from backend.pipeline.producers.tts_voice import pick_voice

            if channel_voice:
                voice = channel_voice
            else:
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
            _raise_if_cancelled()
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

    # 字幕模块 · 回退旁白字幕（原声缺失/ASR 不可用/失败时兜底——
    # 配音后执行，需要旁白音频时长/起始偏移做时间轴对齐）
    if (
        srt_path is None
        and want_subtitle
        and bool(getattr(settings, "pipeline_enable_asr", True))
    ):
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
    _raise_if_cancelled()
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
    # 平均哈希 → 发布闸门比对已发布条目。
    # v0.11.4：一律用 raw 源片计算——成片 phash 被烧录字幕带/统一缩放主导
    # （实测两个不同源视频的成片 phash 仅差 4 位 → 误判重复），
    # raw 才反映真实内容（同一素材二次加工/直发仍能正确判重）
    if artifacts.get("video") is not None:
        from backend.pipeline.phash import compute_phash

        artifacts["phash"] = await compute_phash(str(raw_path))
        if artifacts["phash"]:
            logger.debug("item phash=%s (raw=%s)", artifacts["phash"], raw_path)
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


# ---------- 文字故事产线（v0.11.7 情感频道第二阶段·半自动内容生产） ----------
#
# text_only 帖（Reddit 情感版块：AmItheAsshole/TrueOffMyChest/offmychest…）：
# selftext → LLM 中文故事旁白 → TTS 固定中文音色 → 渐变背景+标题卡 →
# 字幕烧录合成。无原始画面，phash 无意义 → None（去重靠标题指纹）。

# 深紫→暖紫垂直渐变（IP 视觉基调）
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
    font = _subtitle_font(56)
    max_w = w - 160
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
    narration = str(script.get("narration") or "").strip()
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
    script["narration"] = narration.strip()[:1200]
    script["source"] = src
    script["content_source"] = "selftext"
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
    tts = await synthesize_tts(ai, script["narration"], audio_path, voice=voice)
    audio_dur = await probe_audio_duration(audio_path)
    if audio_dur <= 0:
        audio_dur = 60.0  # 探测失败 → 按默认 1 分钟兜底
    artifacts["audio"] = {"path": str(audio_path), "bytes": tts.get("bytes", 0)}
    _raise_if_cancelled()

    # 4. 字幕（中文旁白 → 断句 → 按字符比例对齐时长 → SRT → ASS）
    sentences = _split_story_sentences(script["narration"])
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


async def _probe_video_params(ffprobe: str, path: Path) -> tuple[int, int, float, bool] | None:
    """主片 (宽, 高, fps, 是否含音轨)；无法解析返回 None（调用方跳过片头）。"""
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "quiet", "-print_format", "json", "-show_streams",
        str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    try:
        data = json.loads(out.decode() or "{}")
    except ValueError:
        return None
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    if not v.get("width"):
        return None
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    rate = str(v.get("r_frame_rate") or "30/1")
    num, _, den = rate.partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    return (
        int(v.get("width") or 1280),
        int(v.get("height") or 720),
        fps if fps > 0 else 30.0,
        has_audio,
    )


async def _prepend_channel_intro(channel, main: Path) -> Path:
    """栏目动态标题卡前置：渲染栏目名底卡 → 按主片参数编码 → concat。

    非破坏性：ffprobe 缺失 / 编码失败 / 产物校验不过 → 返回原成片路径。
    intro_config: {"enabled": true, "duration_s": 3, "subtitle": "..."}
    """
    ffmpeg = find_ffmpeg()
    ffprobe = find_ffprobe()
    if not ffmpeg or not ffprobe:
        logger.warning("intro skipped: ffmpeg/ffprobe unavailable")
        return main
    cfg = channel.intro_config or {}
    if not cfg.get("enabled"):
        return main  # 双保险：调用方已查 intro_enabled，此处兜底
    duration = max(1.0, min(float(cfg.get("duration_s") or 3), 10.0))
    subtitle = str(cfg.get("subtitle") or "").strip()

    params = await _probe_video_params(ffprobe, main)
    if params is None:
        # 主片不可解析（损坏/占位）→ 不做任何替换（非破坏性）
        logger.warning("intro skipped: main video unprobeable")
        return main
    width, height, fps, has_audio = params

    # 标题底卡：复用故事产线 PIL 渐变渲染器（栏目名大字 + 副题署名）
    card = main.parent / "intro_card.png"
    await asyncio.to_thread(_render_story_bg, channel.name, card, credit=subtitle)

    intro = main.parent / "intro_clip.mp4"
    vf = f"scale={width}:{height}"
    if has_audio:
        cmd = [
            str(ffmpeg), "-y",
            "-loop", "1", "-i", str(card),
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t", f"{duration:.3f}",
            "-vf", vf, "-r", f"{fps:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-c:a", "aac", "-b:a", "160k",
            "-shortest",
            str(intro),
        ]
    else:
        cmd = [
            str(ffmpeg), "-y",
            "-loop", "1", "-i", str(card),
            "-t", f"{duration:.3f}",
            "-vf", vf, "-r", f"{fps:.3f}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium",
            "-an",
            str(intro),
        ]
    await _run_cmd(cmd)

    merged = main.parent / "final_with_intro.mp4"
    concat_list = main.parent / "concat_intro.txt"
    await asyncio.to_thread(
        concat_list.write_text,
        f"file '{intro.as_posix()}'\nfile '{main.as_posix()}'\n",
    )
    try:
        await _run_cmd([
            str(ffmpeg), "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy",
            str(merged),
        ])
        ok = await asyncio.to_thread(merged.exists) and (
            await asyncio.to_thread(merged.stat)
        ).st_size >= 1024
        if not ok:
            logger.warning("intro concat produced no output — keep original")
            return main
        await asyncio.to_thread(main.unlink)
        await asyncio.to_thread(merged.rename, main)
        return main
    finally:
        for p in (concat_list,):
            await asyncio.to_thread(p.unlink, missing_ok=True)
