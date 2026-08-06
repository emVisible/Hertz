"""Download source adapters.

Each adapter knows how to (a) describe a URL into selectable formats and
(b) fetch the content. generic uses the chunked engine; bilibili and
youtube delegate to yt-dlp for format negotiation and muxing (DASH
complexity, cookies, referers — all handled upstream).
"""

from backend.download.sources.bilibili import BilibiliSource
from backend.download.sources.generic import GenericSource
from backend.download.sources.youtube import YoutubeSource

__all__ = ["BilibiliSource", "GenericSource", "YoutubeSource"]
