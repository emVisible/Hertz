"""Video thumbnail extraction via ffmpeg.

Smart frame pick (Autarkeia heritage): sample 4 timestamps across the
video, score each frame's mean luma via signalstats, pick the frame whose
luma is closest to a mid-tone (skips black frames / pure white). Pure
ffmpeg, no PIL dependency.
"""

import asyncio
import re
import shutil
from functools import lru_cache
from pathlib import Path

THUMB_SUFFIX = ".thumb.jpg"

_SAMPLE_RATIOS = (0.1, 0.35, 0.6, 0.85)
_TARGET_LUMA = 0.55
_LUMA_OK = (0.2, 0.85)


@lru_cache(maxsize=1)
def find_ffmpeg() -> str | None:
    return shutil.which("ffmpeg")


def thumb_path_for(media_path: Path, thumb_dir: Path | None = None) -> Path:
    """Sidecar thumbnail next to the media (HeartStone pattern)."""
    return Path(f"{media_path}{THUMB_SUFFIX}")


async def _probe_duration(media_path: Path) -> float:
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return 0.0
    proc = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-i",
        str(media_path),
        "-f",
        "null",
        "-",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=20)
    except TimeoutError:
        proc.kill()
        return 0.0
    match = re.search(r"Duration: (\d+):(\d+):(\d+\.\d+)", stderr.decode("utf-8", "ignore"))
    if not match:
        return 0.0
    h, m, s = match.groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


async def _frame_luma(ffmpeg: str, media_path: Path, at: float) -> float | None:
    """Extract a single frame's mean luma in [0,1] via signalstats metadata."""
    proc = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-ss",
        f"{at:.2f}",
        "-i",
        str(media_path),
        "-frames:v",
        "1",
        "-vf",
        "signalstats,metadata=print:file=-",
        "-f",
        "null",
        "-",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=20)
    except TimeoutError:
        proc.kill()
        return None
    text = stderr.decode("utf-8", "ignore")
    match = re.search(r"lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    return float(match.group(1)) / 255.0


async def _extract_frame(ffmpeg: str, media_path: Path, at: float, out: Path) -> bool:
    proc = await asyncio.create_subprocess_exec(
        ffmpeg,
        "-y",
        "-ss",
        f"{at:.2f}",
        "-i",
        str(media_path),
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "5",
        str(out),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        code = await asyncio.wait_for(proc.wait(), timeout=30)
    except TimeoutError:
        proc.kill()
        return False
    return code == 0 and await asyncio.to_thread(out.exists)


async def generate_thumbnail(media_path: Path) -> Path | None:
    """Score 4 sampled frames, write the best as `<media>.thumb.jpg`."""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        return None
    thumb = thumb_path_for(media_path)
    duration = await _probe_duration(media_path)
    if duration <= 0:
        duration = 30.0

    candidates: list[tuple[float, float]] = []  # (score_distance, timestamp)
    for ratio in _SAMPLE_RATIOS:
        at = min(duration * ratio, duration - 0.5)
        if at < 0:
            continue
        luma = await _frame_luma(ffmpeg, media_path, at)
        if luma is None:
            continue
        if not (_LUMA_OK[0] <= luma <= _LUMA_OK[1]):
            continue
        candidates.append((abs(luma - _TARGET_LUMA), at))
    if not candidates:
        # fall back to 1s, whatever it looks like
        candidates = [(0.0, 1.0 if duration > 1 else 0.0)]
    candidates.sort()
    best_at = candidates[0][1]
    ok = await _extract_frame(ffmpeg, media_path, best_at, thumb)
    return thumb if ok else None
