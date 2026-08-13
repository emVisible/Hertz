"""Edge TTS provider (Microsoft neural voices, free)."""

import asyncio

import edge_tts

# Any network operation needs an explicit deadline (AXIOM §25):
# an unreachable TTS endpoint must fail the step, not hang it.
SYNTHESIZE_TIMEOUT_S = 60


class EdgeTTSProvider:
    """Satisfies the TTSProvider protocol structurally."""

    VOICES = {
        "en-US-AndrewNeural": "English male · Andrew (clear)",
        "en-US-BrianNeural": "English male · Brian (warm)",
        "en-US-GuyNeural": "English male · Guy (narrative)",
        "en-US-JennyNeural": "English female · Jenny (bright)",
        "en-US-AriaNeural": "English female · Aria (soft)",
        "en-GB-RyanNeural": "UK male · Ryan (crisp)",
        "en-GB-SoniaNeural": "UK female · Sonia (warm)",
        "en-AU-WilliamNeural": "AU male · William (casual)",
        "en-AU-NatashaNeural": "AU female · Natasha (friendly)",
        "zh-CN-XiaoxiaoNeural": "中文女声·晓晓",
        "zh-CN-YunxiNeural": "中文男声·云希",
    }

    async def synthesize(self, text: str, voice: str, rate: str = "+0%") -> bytes:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        chunks: list[bytes] = []

        async def collect() -> None:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    chunks.append(chunk["data"])

        try:
            await asyncio.wait_for(collect(), timeout=SYNTHESIZE_TIMEOUT_S)
        except TimeoutError as exc:
            raise RuntimeError(f"Edge TTS timed out after {SYNTHESIZE_TIMEOUT_S}s") from exc
        if not chunks:
            raise RuntimeError(f"Edge TTS produced no audio for voice {voice}")
        return b"".join(chunks)

    async def aclose(self) -> None:
        pass
