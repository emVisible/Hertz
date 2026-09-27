"""BGM mix — HyperFrames captures exactly ONE <audio> track per render, so any
background music must be baked into the voice file before composition.

We keep ``audio/narration.wav`` as pure voice (the source of truth for resynth),
and derive ``audio/mix.wav`` = voice + side-chain-ducked, faded music bed. When a
bgm is attached the composition's single ``<audio id="vo">`` points at the mix;
otherwise at the raw narration. Fully deterministic (ffmpeg), no browser mixing.
"""
from __future__ import annotations

import asyncio
from pathlib import Path


async def build_voice_mix(
    narration: Path, bgm: Path, out: Path, *,
    total: float, volume: float = 0.22, duck: bool = True,
    fade_in: float = 1.5, fade_out: float = 2.0,
) -> None:
    """Bake a ducked, faded music bed under the voice. amix scales each input by
    ~0.707 even at normalize=0, so voice is pre-boosted by sqrt(2) to stay at
    unity (measured: 2 kHz voice-only band unchanged) while the bed rides under it.
    """
    tout = max(0.0, total - fade_out)
    sqrt2 = "1.41421356"
    voice = f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume={sqrt2}[vo]"
    bed = (
        f"[1:a]aformat=sample_rates=48000:channel_layouts=stereo,"
        f"aloop=loop=-1:size=2e9,atrim=0:{total:.3f},asetpts=PTS-STARTPTS,"
        f"volume={volume},afade=t=in:d={fade_in},afade=t=out:st={tout:.3f}:d={fade_out}[bed]"
    )
    if duck:
        fc = (
            f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[vraw][vs];"
            f"[vraw]volume={sqrt2}[vo];{bed};"
            f"[bed][vs]sidechaincompress=threshold=0.15:ratio=3:attack=30:release=400:makeup=1[ducked];"
            f"[vo][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]"
        )
    else:
        fc = f"{voice};{bed};[vo][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]"
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-v", "error", "-y",
        "-i", str(narration), "-i", str(bgm),
        "-filter_complex", fc, "-map", "[mix]",
        "-ar", "48000", "-ac", "2", str(out),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"bgm mix failed: {err.decode()[-400:]}")


async def ensure_voice_track(ws, config: dict, total: float) -> str:
    """(Re)build mix.wav when a bgm is attached; return the composition-relative
    src the single ``<audio id=vo>`` should use. Removes stale mix when no bgm."""
    mix = ws.comp_audio / "mix.wav"
    bgm_cfg = config.get("bgm")
    if not bgm_cfg:
        mix.unlink(missing_ok=True)
        return "audio/narration.wav"
    bgm_path = ws.composition / str(bgm_cfg["src"])
    if not bgm_path.exists():
        mix.unlink(missing_ok=True)
        return "audio/narration.wav"
    await build_voice_mix(
        ws.narration_wav, bgm_path, mix,
        total=total, volume=float(bgm_cfg.get("volume", 0.22)),
        duck=bool(bgm_cfg.get("duck", True)),
        fade_in=float(bgm_cfg.get("fade_in", 1.5)), fade_out=float(bgm_cfg.get("fade_out", 2.0)),
    )
    return "audio/mix.wav"

