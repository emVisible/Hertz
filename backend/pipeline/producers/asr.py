"""ASR — 原声转写（v0.8.9，对齐原项目 subtitle.py transcribe_with_whisper /
transcribe_with_xinference）。

翻译生产方式（translate）= 提取视频原话 → 中文字幕。转写双通道：
xinference STT 服务优先（快，OpenAI 兼容 multipart），faster-whisper 本地
CPU（base/int8）兜底。依赖 faster-whisper 属于 optional extra：
    uv sync --extra asr
未安装时 asr_available() 返回 False，调用方回退旁白翻译（不阻塞生产）。
"""

import asyncio
import logging
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

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


async def transcribe_with_whisper(
    media_path: Path, out_srt: Path, *, language: str | None = None
) -> Path | None:
    """faster-whisper 转写 → 带时间戳 SRT。language=None 自动检测（英文优先）。"""
    from backend.pipeline.producers.media import script_to_srt  # 复用 SRT 写入

    try:
        model = await _get_whisper()
        segments, _ = await asyncio.to_thread(
            model.transcribe, str(media_path), language=language or None
        )
        text_parts: list[str] = []
        durations: list[float] = []
        for seg in segments:
            text_parts.append(seg.text.strip())
            durations.append(seg.end - seg.start)
        text = " ".join(p for p in text_parts if p).strip()
        if not text:
            return None
        out_srt.parent.mkdir(parents=True, exist_ok=True)
        script_to_srt(text, sum(durations), out_srt)
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
        # xinference 无分段时间戳——按整段文本生成（时长 0 时 script_to_srt 回退每字估时）
        from backend.pipeline.producers.media import script_to_srt

        script_to_srt(text, 0.0, out_srt)
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
