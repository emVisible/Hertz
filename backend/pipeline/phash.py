"""Phash — average-hash duplicate detection (Autarkeia heritage).

Perceptual hash of the produced video: one frame at ~25% in, downscaled to
8×8 grayscale, hashed as 64 bits (bit = pixel brighter than frame average).
Two videos with the same phash are near-certainly the same footage — used as
a publish gate (block_publish_duplicates) on top of the existing
(source, source_id) uniqueness.
"""

import asyncio
import json
import logging

from backend.library.thumbnails import find_ffmpeg, find_ffprobe

logger = logging.getLogger(__name__)


async def _probe_duration(video_path: str) -> float:
    """ffprobe 时长（秒）；失败返回 0（此时不 seek 直接取首帧）。"""
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return 0.0
    try:
        proc = await asyncio.create_subprocess_exec(
            ffprobe, "-v", "quiet", "-print_format", "json", "-show_format",
            video_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
        data = json.loads(out.decode())
        return float(data.get("format", {}).get("duration") or 0.0)
    except (TimeoutError, OSError, ValueError, json.JSONDecodeError):
        return 0.0


async def compute_phash(video_path: str | None) -> str | None:
    """Compute the average hash of a video file. Returns hex string or None
    when ffmpeg is unavailable / the file is unreadable (dedupe is a gate,
    not a hard requirement — failure degrades to 'no phash')."""
    if not video_path:
        return None
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return None
    # ffmpeg 7+ 不再支持 -ss 25% 百分比 seek：先探测时长再换算秒
    duration = await _probe_duration(video_path)
    ss_args = ["-ss", str(max(duration * 0.25, 0.0))] if duration > 0 else []
    cmd = [
        str(ffmpeg), "-v", "error",
        *ss_args, "-i", video_path,
        "-frames:v", "1",
        "-vf", "scale=8:8,format=gray",
        "-f", "rawvideo", "-",
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
    except (TimeoutError, OSError):
        logger.debug("phash extraction failed for %s", video_path)
        return None
    if proc.returncode != 0 or len(out) < 64:
        return None

    pixels = list(out[:64])
    avg = sum(pixels) / 64.0
    bits = [1 if p > avg else 0 for p in pixels]
    # 64 bits → 16 hex chars
    bytes_out = []
    for i in range(8):
        chunk = bits[i * 8:(i + 1) * 8]
        byte = sum(b << (7 - j) for j, b in enumerate(chunk))
        bytes_out.append(f"{byte:02x}")
    return "".join(bytes_out)
