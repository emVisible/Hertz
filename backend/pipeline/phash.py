"""Phash — average-hash duplicate detection (Autarkeia heritage).

Perceptual hash of the produced video: one frame at ~25% in, downscaled to
8×8 grayscale, hashed as 64 bits (bit = pixel brighter than frame average).
Two videos with the same phash are near-certainly the same footage — used as
a publish gate (block_publish_duplicates) on top of the existing
(source, source_id) uniqueness.
"""

import asyncio
import logging

from backend.library.thumbnails import find_ffmpeg
from backend.pipeline.producers.probe import probe_duration, probe_video_duration

logger = logging.getLogger(__name__)


async def compute_phash(video_path: str | None) -> str | None:
    """Compute the average hash of a video file. Returns hex string or None
    when ffmpeg is unavailable / the file is unreadable (dedupe is a gate,
    not a hard requirement — failure degrades to 'no phash')."""
    if not video_path:
        return None
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return None
    # ffmpeg 7+ 不再支持 -ss 25% 百分比 seek：先探测时长再换算秒。
    # 取**视频流**时长：容器时长取最长那条流（通常是音频），素材里「音频比画面长」时
    # 按容器换算出的 25% 会越过画面末尾，seek 落空 → 哈希直接算不出来（静默降级）。
    duration = await probe_video_duration(video_path) or await probe_duration(video_path)
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
