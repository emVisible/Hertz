"""ASR — 原声转写（v0.8.9，对齐原项目 subtitle.py transcribe_with_whisper /
transcribe_with_xinference）。

翻译生产方式（translate）= 提取视频原话 → 中文字幕。转写双通道：
xinference STT 服务优先（快，OpenAI 兼容 multipart），faster-whisper 本地
CPU（base/int8）兜底。依赖 faster-whisper 属于 optional extra：
    uv sync --extra asr
未安装时 asr_available() 返回 False，调用方回退旁白翻译（不阻塞生产）。

v0.11.1 时间轴对齐（专业字幕口径）：whisper 通道改为词级时间戳
（word_timestamps=True + vad 过滤静音）→ _words_to_cues 按说话者节奏
（停顿/标点/长度）断句 → 保留原声真实位置写入 SRT。此前整段文本
重构后按词数权重重新铺满总时长，字幕位置与音频严重错位。
"""

import asyncio
import logging
import math
import re
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

# 断句参数（v0.11.1，专业字幕口径）
_PAUSE_GAP = 0.35      # 词间停顿 ≥ 0.35s → 断句（说话者自然停顿）
_MAX_EN_WORDS = 11     # 英文 cue 词数上限（每行可读性）
_MAX_ZH_CHARS = 22     # 中文 cue 字数上限（对齐项目字幕 22 字红线）
_MAX_CUE_SPAN = 3.5    # 单 cue 跨度硬上限（无标点长句不许糊成一长条）
_MIN_CUE_DUR = 0.35    # 低于此时长的 cue 并入相邻 cue（一闪而过不可读）

_SENT_END_RE = re.compile(r"[.!?。！？；;…]\s*$")

# 繁体检测（v0.11.2）：base 模型中文常输出繁体——含这些字符触发简体重转
_TRADITIONAL_CHARS = frozenset(
    "這橋撐從裡們當體還馬電門開關對應該聽華飛車來個時間邊長樣億萬義鳥"
    "說話見建築點兩國寫讀買賣東練習龍鳳歸還為於無與卻後乾淨盡寧願緣紅"
)


def _has_traditional(text: str) -> bool:
    return any(ch in _TRADITIONAL_CHARS for ch in (text or ""))

_WHISPER_IMPORTED = False
try:  # optional extra（pyproject [project.optional-dependencies].asr）
    from faster_whisper import WhisperModel  # type: ignore

    _WHISPER_IMPORTED = True
except ImportError:  # pragma: no cover — 未装 extra 的正常降级路径
    WhisperModel = None  # type: ignore[assignment,misc]

_whisper_model = None
_whisper_lock = asyncio.Lock()


def whisper_available() -> bool:
    return _WHISPER_IMPORTED


def xinference_configured() -> bool:
    return bool((settings.xinference_stt_model_id or "").strip())


def asr_available() -> bool:
    """任一 ASR 通道可用（xinference 服务配置 或 本地 whisper 已装）。"""
    return xinference_configured() or whisper_available()


async def _get_whisper():
    """懒加载 faster-whisper base 模型（首次调用下载 ~150MB，缓存于 ~/.cache）。"""
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    async with _whisper_lock:
        if _whisper_model is not None:
            return _whisper_model
        if not _WHISPER_IMPORTED:
            raise RuntimeError("faster-whisper not installed — run `uv sync --extra asr`")
        _whisper_model = await asyncio.to_thread(
            WhisperModel, "base", device="cpu", compute_type="int8"
        )
        return _whisper_model


def _is_zh(text: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def _join_cue_texts(*texts: str) -> str:
    """词/句拼接：中文无空格直接拼（whisper 中文字符不带空格），其余单词间留一个空格。"""
    joined = " ".join(t.strip() for t in texts if t.strip())
    if _is_zh(joined):
        return re.sub(r"\s+", "", joined)
    return re.sub(r"\s+", " ", joined).strip()


def _words_to_cues(
    words: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    """把 whisper 词级时间戳按说话者节奏分组为字幕 cue（v0.11.1）：

    - 词间停顿 ≥ _PAUSE_GAP → 断句（说话者自然停顿，停顿少于阈值则连句）
    - 句末标点且当前 cue ≥ 2 词 → 断句（说话者完成一个意群）
    - 英文 ≥ _MAX_EN_WORDS 词 / 中文 ≥ _MAX_ZH_CHARS 字 → 硬截断（过长语流）
    - cue 跨度 > _MAX_CUE_SPAN 且 ≥ 2 词 → 硬截断（防无标点长句糊条）
    - 时长 < _MIN_CUE_DUR 的碎片并入相邻 cue（一闪而过不可读）

    返回 (start, end, text)——时间戳即原声真实位置，供 _write_srt_cues 直写。
    """
    if not words:
        return []
    cues: list[list[tuple[float, float, str]]] = [[]]
    for start, end, text in words:
        if end <= start or not (math.isfinite(start) and math.isfinite(end)):
            continue  # 非法时间戳（NaN/倒置）不进 cue
        cur = cues[-1]
        if cur:
            prev_end = cur[-1][1]
            has_zh = _is_zh("".join(w[2] for w in cur))
            length = sum(
                len(w[2].strip())
                for w in cur
            ) if has_zh else sum(
                len(w[2].strip().split()) for w in cur
            )
            break_cue = (
                start - prev_end >= _PAUSE_GAP
                or (_SENT_END_RE.search(cur[-1][2]) and len(cur) >= 2)
                or length >= (_MAX_ZH_CHARS if has_zh else _MAX_EN_WORDS)
                or (start - cur[0][0] >= _MAX_CUE_SPAN and len(cur) >= 2)
            )
            if break_cue:
                cues.append([])
        cues[-1].append((start, end, text))

    merged: list[tuple[float, float, str]] = []
    for cue in cues:
        if not cue:
            continue
        start, end = cue[0][0], cue[-1][1]
        text = _join_cue_texts(*(w[2] for w in cue))
        if not text:
            continue
        if merged and end - start < _MIN_CUE_DUR:
            ps, pe, pt = merged[-1]
            # 仅当与上一 cue 紧邻（真延续）才并入——隔着长停顿的碎片
            # 保持独立 cue（并入会凭空吞掉整段停顿）
            if start - pe < _PAUSE_GAP:
                merged[-1] = (ps, max(pe, end), _join_cue_texts(pt, text))
                continue
        merged.append((start, end, text))
    if len(merged) >= 2 and merged[0][1] - merged[0][0] < _MIN_CUE_DUR:
        s0, e0, t0 = merged.pop(0)
        ns, ne, nt = merged[0]
        merged[0] = (ns, max(ne, e0), _join_cue_texts(t0, nt))
    return merged


def _collect_words(segments) -> list[tuple[float, float, str]]:
    """从 whisper 段提取词级时间戳（v0.11.1：过滤 NaN/倒置/空白词）。"""
    words: list[tuple[float, float, str]] = []
    for seg in segments:
        for w in (seg.words or []):
            word_text = (w.word or "").strip()
            if not word_text:
                continue
            start, end = float(w.start), float(w.end)
            if (
                math.isnan(start) or math.isnan(end)
                or math.isinf(start) or math.isinf(end)
                or end <= start
            ):
                continue
            words.append((start, end, word_text))
    return words


async def transcribe_with_whisper(
    media_path: Path, out_srt: Path, *, language: str | None = None
) -> Path | None:
    """faster-whisper 转写 → 词级时间戳 → 按说话者节奏断句 → 精确对齐 SRT。

    v0.11.1：不再把整段文本拼起来按词数权重重新铺满总时长（会丢失原声
    位置造成字幕错位）——word_timestamps=True 取每个词的绝对时间，
    _words_to_cues 按停顿/标点/长度断句，_write_srt_cues 直写原始时间轴。
    vad_filter=True 先滤静音，避免幻听与静音区残字。
    language=None 自动检测（英文优先）。

    v0.11.2：中文自动检测若输出繁体 → 带简体 initial_prompt 重转一遍
    （base 模型 zh 常偏繁体且繁体状态下误认生僻字）。
    """
    from backend.pipeline.producers.media import _write_srt_cues

    try:
        model = await _get_whisper()
        segments, _ = await asyncio.to_thread(
            model.transcribe, str(media_path), language=language or None,
            word_timestamps=True, vad_filter=True,
        )
        words = _collect_words(segments)
        if not language and _has_traditional("".join(w[2] for w in words)):
            logger.info(
                "zh text has traditional chars — retranscribing in simplified"
            )
            segments, _ = await asyncio.to_thread(
                model.transcribe, str(media_path), language="zh",
                word_timestamps=True, vad_filter=True,
                initial_prompt="以下是简体中文的普通话。",
            )
            words = _collect_words(segments)
        cues = _words_to_cues(words)
        if not cues:
            return None
        out_srt.parent.mkdir(parents=True, exist_ok=True)
        _write_srt_cues(out_srt, cues)
        return out_srt
    except Exception as exc:  # noqa: BLE001 — 转写失败回退脚本字幕
        logger.warning("whisper transcription failed: %s", exc)
        return None


async def transcribe_with_xinference(media_path: Path, out_srt: Path) -> Path | None:
    """xinference STT 服务（OpenAI 兼容 /v1/audio/transcriptions multipart）。"""
    import httpx

    if not xinference_configured():
        return None
    url = f"{settings.xinference_stt_base_url.rstrip('/')}/audio/transcriptions"
    headers = {
        "Authorization": f"Bearer {settings.xinference_api_key or 'not-needed'}"
    }
    data = {"model": settings.xinference_stt_model_id}
    try:
        audio = await asyncio.to_thread(media_path.read_bytes)
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                url,
                headers=headers,
                files={"file": ("audio.wav", audio, "application/octet-stream")},
                data=data,
            )
            resp.raise_for_status()
            result = resp.json()
        text = (
            str((result or {}).get("text") or "").strip()
            if isinstance(result, dict)
            else str(result).strip()
        )
        if not text:
            return None
        out_srt.parent.mkdir(parents=True, exist_ok=True)
        # xinference 无分段时间戳——按句断行后分布到真实音频时长
        # （v0.11.1：传 probe_audio_duration 而非 0.0，避免每字估时把
        # 长对话压成几秒；无音轨探测失败时退回每字估时）
        from backend.pipeline.producers.media import probe_audio_duration, script_to_srt

        audio_dur = 0.0
        try:
            audio_dur = await probe_audio_duration(media_path) or 0.0
        except Exception as exc:  # noqa: BLE001 — 探测失败回退每字估时
            logger.warning("audio duration probe failed for xinference subs: %s", exc)
        script_to_srt(text, audio_dur, out_srt)
        return out_srt
    except Exception as exc:  # noqa: BLE001 — 服务不可用回退 whisper/脚本
        logger.warning("xinference transcription failed: %s", exc)
        return None


async def transcribe(media_path: Path, out_srt: Path) -> Path | None:
    """双通道转写：xinference 优先（快），whisper 本地兜底。"""
    got = await transcribe_with_xinference(media_path, out_srt)
    if got is not None:
        return got
    if whisper_available():
        return await transcribe_with_whisper(media_path, out_srt)
    return None
