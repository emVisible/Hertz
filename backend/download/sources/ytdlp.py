"""yt-dlp shared adapter: format negotiation + muxed download.

Both Bilibili and YouTube DASH streams are negotiated and merged by
yt-dlp (cookies, referers, codecs, audio+video muxing). We drive it as
a subprocess (never shell), streaming progress to the caller.

Security: the download command never receives secrets in argv (cookies
via file only); URLs are validated as https in the router layer.
"""

import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.download.errors import HTTPStatusError, URLNotSupportedError

ProgressCallback = Callable[[int, int], Awaitable[None]]


def _ytdlp_cmd(args: list[str]) -> list[str]:
    return [sys.executable, "-m", "yt_dlp", *args]


async def _run_json(
    url: str, extra: list[str] | None = None, timeout_s: float = 120
) -> dict:
    """yt-dlp --dump-json for a single video (no playlist)."""
    cmd = _ytdlp_cmd(
        [
            "--dump-json",
            "--no-playlist",
            "--no-warnings",
            "--flat-playlist",
            *(extra or []),
            url,
        ]
    )
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except TimeoutError:
        proc.kill()
        raise HTTPStatusError(0, "yt-dlp timed out") from None
    if proc.returncode != 0:
        raise URLNotSupportedError("yt-dlp could not resolve the video")
    try:
        return json.loads(out.decode("utf-8"))
    except json.JSONDecodeError:
        raise URLNotSupportedError("yt-dlp returned malformed metadata") from None


def build_formats(info: dict) -> list[dict]:
    """Flatten yt-dlp formats into selectable {format_id, label, ext, kind, muxed}."""
    formats: list[dict] = []
    for f in info.get("formats", []):
        if f.get("format_id") in (None, "none"):
            continue
        vcodec = f.get("vcodec")
        acodec = f.get("acodec")
        has_video = vcodec not in (None, "none")
        has_audio = acodec not in (None, "none")
        if not has_video and not has_audio:
            continue
        kind = "video" if has_video else "audio"
        resolution = f.get("resolution") or f.get("height") or ""
        parts = [kind]
        if resolution:
            parts.append(str(resolution))
        if f.get("ext"):
            parts.append(str(f["ext"]))
        formats.append(
            {
                "format_id": str(f["format_id"]),
                "label": " / ".join(parts),
                "ext": f.get("ext") or "",
                "kind": kind,
                "muxed": has_audio,  # 纯视频流（DASH）需合并音轨才有声音
                "filesize": f.get("filesize") or f.get("filesize_approx"),
            }
        )
    formats.sort(key=lambda x: (x["kind"] != "video", x["label"]))
    return formats


def best_audio_id(info: dict) -> str | None:
    """Highest-bitrate standalone audio stream (for DASH muxing)."""
    audios = [
        f
        for f in info.get("formats", [])
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
        and f.get("format_id") not in (None, "none")
    ]
    if not audios:
        return None
    return str(max(audios, key=lambda f: f.get("abr") or 0)["format_id"])


def quality_options(info: dict) -> list[dict]:
    """精选画质档位（HeartStone 风格）：按分辨率去重，每档取最优视频流。

    与 build_formats 的原始格式列表不同——同一分辨率下的 video-only /
    muxed / 不同编码只出现一次，避免「一个分辨率三个可选项」。
    """
    videos = [
        f
        for f in info.get("formats", [])
        if f.get("vcodec") not in (None, "none")
        and f.get("format_id") not in (None, "none")
    ]
    by_height: dict[int, dict] = {}
    for f in videos:
        height = f.get("height") or 0
        # 同一分辨率取「带音轨优先 → 高码率优先」
        cur = by_height.get(height)
        if cur is None or (
            f.get("acodec") not in (None, "none") != (cur.get("acodec") not in (None, "none"))
            and f.get("acodec") not in (None, "none")
        ) or (
            f.get("acodec") not in (None, "none")
            == (cur.get("acodec") not in (None, "none"))
            and (f.get("tbr") or 0) > (cur.get("tbr") or 0)
        ):
            by_height[height] = f
    options = []
    for height in sorted(by_height, reverse=True):
        f = by_height[height]
        res = f.get("resolution") or (f"{height}p" if height else "SD")
        label = f"{res} / {f.get('ext') or 'mp4'}"
        if f.get("acodec") not in (None, "none"):
            label += "（含音轨）"
        options.append(
            {
                "format_id": str(f["format_id"]),
                "label": label,
                "height": height,
                "muxed": f.get("acodec") not in (None, "none"),
            }
        )
    audio_id = best_audio_id(info)
    if audio_id:
        options.append({"format_id": audio_id, "label": "仅音频", "height": 0, "muxed": True})
    if not options:
        first = videos[:1]
        options = [
            {
                "format_id": str(f["format_id"]),
                "label": f.get("resolution") or "原画",
                "height": 0,
                "muxed": True,
            }
            for f in first
        ]
    return options


async def download_via_ytdlp(
    url: str,
    format_id: str,
    audio_id: str | None,
    dest: Path,
    *,
    on_progress: ProgressCallback | None = None,
) -> None:
    """Download and mux a video into `dest` (mp4)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fmt = format_id if not audio_id else f"{format_id}+{audio_id}"
    args = [
        "--no-playlist",
        "--no-warnings",
        "-f",
        fmt,
        "--merge-output-format",
        "mp4",
        "--newline",
        "--progress-template",
        "download:{%(info.total_bytes|string)s}|{%(info.downloaded_bytes|string)s}",
        "-o",
        str(dest),
        url,
    ]
    proc = await asyncio.create_subprocess_exec(
        *_ytdlp_cmd(args),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    assert proc.stdout is not None
    try:
        async for line in proc.stdout:
            text = line.decode("utf-8", errors="replace").strip()
            if text.startswith("download:{"):
                try:
                    total, downloaded = text.removeprefix("download:{").split("}|{")
                    total_i = int(float(total or 0))
                    down_i = int(float(downloaded or 0))
                    if on_progress:
                        await on_progress(down_i, total_i)
                except (ValueError, IndexError):
                    pass
        code = await proc.wait()
    except asyncio.CancelledError:
        proc.kill()
        await proc.wait()
        raise
    if code != 0:
        await asyncio.to_thread(dest.unlink, True)
        raise HTTPStatusError(code, "yt-dlp download failed")
