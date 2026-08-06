"""URL parsing and classification for download sources.

Classifies a user-supplied URL into one of the supported providers
(bilibili / youtube / generic-direct / generic-page) so the download
service can pick the right adapter (AXIOM §5.1: single dispatch).
"""

import ipaddress
import re
from dataclasses import dataclass
from urllib.parse import urlparse

from backend.download.errors import URLNotSupportedError

# Hostname whitelist: only these hosts may trigger yt-dlp (SSRF guard —
# lookalike strings like "http://internal/x/youtube.com/…" never match).
BILI_HOSTS = {"bilibili.com", "www.bilibili.com", "m.bilibili.com", "b23.tv"}
YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}

# Extensions that strongly imply a direct media file
DIRECT_EXT_RE = re.compile(
    r"\.(?:mp4|webm|mkv|mov|avi|flv|m4v|mp3|wav|aac|flac|ogg|m4a|webp|jpg|jpeg|png|gif|bmp|heic|avif)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class ParsedURL:
    provider: str  # bilibili | youtube | generic
    kind: str  # video | audio | image | page
    url: str
    title_hint: str | None = None


def is_public_http_url(url: str) -> bool:
    """Static SSRF guard for user-supplied URLs (AXIOM §8.1).

    http(s) only, no embedded credentials; blocks private/loopback/reserved
    IP literals and loopback hostnames before any request is made. Full
    DNS-resolution checking happens in the download layer
    (``engine.is_safe_media_url``) — this stays offline-friendly.
    """
    p = urlparse(url)
    if p.scheme not in ("http", "https"):
        return False
    if p.username or p.password:
        return False
    host = p.hostname
    if not host:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        return not (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        )
    host_l = host.lower().rstrip(".")
    if host_l == "localhost" or host_l.endswith((".local", ".internal")):
        return False
    return True


def _host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower().rstrip(".")


def parse_url(raw: str) -> ParsedURL:
    """Classify a raw user input (URL, bare BV id, or av id)."""
    url = raw.strip()
    if not url:
        raise URLNotSupportedError("empty URL")

    if re.fullmatch(r"(BV[0-9A-Za-z]{10}|av\d+)", url):
        return ParsedURL("bilibili", "video", url, title_hint="Bilibili")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise URLNotSupportedError(f"unsupported scheme: {parsed.scheme or 'none'}")
    if not parsed.netloc:
        raise URLNotSupportedError(f"not a URL: {url[:64]}")

    host = _host_of(url)
    if host in BILI_HOSTS:
        return ParsedURL("bilibili", "video", url, title_hint="Bilibili")
    if host in YT_HOSTS:
        return ParsedURL("youtube", "video", url, title_hint="YouTube")

    if DIRECT_EXT_RE.search(parsed.path):
        kind = _kind_from_ext(parsed.path)
        return ParsedURL("generic", kind, url, title_hint=parsed.path.rsplit("/", 1)[-1])

    return ParsedURL("generic", "page", url)


def _kind_from_ext(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower()
    if ext in ("mp3", "wav", "aac", "flac", "ogg", "m4a"):
        return "audio"
    if ext in ("webp", "jpg", "jpeg", "png", "gif", "bmp", "heic", "avif"):
        return "image"
    return "video"
