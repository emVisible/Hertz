"""Kokoro TTS provider (local ONNX, tone-correct Chinese via monoline tts_zh).

与 EdgeTTSProvider 同协议（synthesize(text, voice, rate) -> wav bytes），供
TaskRouter 按 protocol 分发。中文走声调路径（misaki G2P + Kokoro），权重位于
`data_dir/models/kokoro`（D-024）；缺权重时 status() 非 ok，调用方回退 edge-tts。
"""

from __future__ import annotations

import asyncio
import io
import re

SYNTHESIZE_TIMEOUT_S = 120


def _rate_to_speed(rate: str) -> float:
    m = re.match(r"\s*([+-]?)(\d+(?:\.\d+)?)\s*%\s*", rate or "")
    if not m:
        return 1.0
    sign, num = m.group(1), float(m.group(2))
    speed = 1.0 + num / 100.0
    if sign == "-":
        speed = max(0.5, 1.0 - num / 100.0)
    return min(2.0, max(0.5, speed))


class KokoroProvider:
    """Satisfies the TTSProvider protocol structurally."""

    def __init__(self, default_voice: str = "zf_xiaoxiao") -> None:
        self.default_voice = default_voice

    @staticmethod
    def available() -> bool:
        from backend.monoline import tts_zh

        return tts_zh.available()

    @staticmethod
    def status() -> str:
        from backend.monoline import tts_zh

        return tts_zh.status()

    @staticmethod
    def voices() -> list[dict]:
        from backend.monoline import voices as _voices

        return _voices.available()

    async def synthesize(self, text: str, voice: str, rate: str = "+0%") -> bytes:
        # A0 对齐上游 HF.tts 语义：先 narration.clean（标点/公式/emoji 读法归一），
        # 再按 rate(spoken) 文本相关系数调速（数字慢、长句快，0.5~2.0 clamp）。
        from backend.monoline import narration as _narration
        from backend.monoline import tts_zh
        from backend.monoline import voices as _voices

        vid = voice if _voices.is_known_voice(voice) else self.default_voice
        spoken = _narration.clean(text)
        if not spoken:
            raise ValueError(f"nothing speakable in {text!r}")
        speed = min(2.0, max(0.5, round(_rate_to_speed(rate) * _narration.rate(spoken), 3)))

        def _run() -> bytes:
            import soundfile as sf

            audio, sr = tts_zh.render(spoken, vid, speed=speed)
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV")
            return buf.getvalue()

        try:
            data = await asyncio.wait_for(asyncio.to_thread(_run), timeout=SYNTHESIZE_TIMEOUT_S)
        except TimeoutError as exc:
            raise RuntimeError(f"Kokoro TTS timed out after {SYNTHESIZE_TIMEOUT_S}s") from exc
        if not data:
            raise RuntimeError(f"Kokoro TTS produced no audio for voice {vid}")
        return data

    async def aclose(self) -> None:
        pass
