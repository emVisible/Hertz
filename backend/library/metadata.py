"""Media metadata extraction via ffprobe (codec / resolution / duration)."""

import asyncio
import json
import shutil
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def find_ffprobe() -> str | None:
    return shutil.which("ffprobe")


async def probe_media(path: Path) -> dict | None:
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return None
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
    except TimeoutError:
        proc.kill()
        return None
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(out.decode("utf-8"))
    except json.JSONDecodeError:
        return None

    fmt = data.get("format", {})
    info: dict = {
        "duration": _float(fmt.get("duration")),
        "bitrate": _int(fmt.get("bit_rate")),
    }
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if video:
        info.update(
            {
                "codec": video.get("codec_name"),
                "width": video.get("width"),
                "height": video.get("height"),
                "fps": _float(video.get("avg_frame_rate")),
            }
        )
    if audio:
        info["audio_codec"] = audio.get("codec_name")
        info["audio_channels"] = audio.get("channels")
    return info


def _float(v) -> float | None:
    try:
        if isinstance(v, str) and "/" in v:
            num, den = v.split("/")
            return float(num) / float(den)
        return float(v)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def _int(v) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None
