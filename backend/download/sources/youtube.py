"""YouTube adapter (yt-dlp based)."""

from dataclasses import dataclass
from pathlib import Path

from backend.download.errors import URLNotSupportedError
from backend.download.sources.ytdlp import (
    _run_json,
    best_audio_id,
    build_formats,
    download_via_ytdlp,
    quality_options,
)


@dataclass
class YoutubeSource:
    async def describe(self, url: str) -> dict:
        info = await _run_json(url)
        title = info.get("title") or info.get("id") or "YouTube video"
        formats = build_formats(info)
        if not formats:
            raise URLNotSupportedError("no downloadable formats found")
        return {
            "title": title,
            "duration": info.get("duration"),
            "uploader": info.get("channel") or info.get("uploader"),
            "thumbnail": info.get("thumbnail"),
            "formats": formats,
            "qualities": quality_options(info),
            "best_audio_id": best_audio_id(info),
        }

    async def download(
        self,
        url: str,
        format_id: str,
        audio_id: str | None,
        dest: Path,
        on_progress=None,
    ) -> None:
        await download_via_ytdlp(url, format_id, audio_id, dest, on_progress=on_progress)
