"""旁白/脚本生成域（v0.22.x B 系解体，自 media.py 迁出）。

职责单一：脚本生成（LLM+启发式兜底）/ 词数预算 / 合规检查 / TTS 合成。
不含：视频合成、字幕处理、封面生成。

依赖：common.ProducerError / config.settings / ai.router.AIRouter。
"""

import asyncio
import logging
from pathlib import Path

from backend.ai.router import AIRouter
from backend.config import settings
from backend.library.thumbnails import find_ffmpeg
from backend.models import script_keys as sk
from backend.pipeline.producers.common import ProducerError, _run_cmd

logger = logging.getLogger(__name__)

# 旁白语速参数（v0.8.9）：~2.3 words/sec，旁白覆盖 ~52% 视频时长
_WPS = 2.3
_RATIO = 0.52


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
        sk.MODE: "script",
        sk.NARRATION: text.strip(),
        sk.SOURCE: "llm" if text else "heuristic",
        sk.CONTENT_SOURCE: script_source,
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


# ---------- 旁白时序（自 media.py 迁入，D-v0.23） ----------

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
