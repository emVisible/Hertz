"""Generic source: direct media links + HTML page asset scanning.

Page scanning adapted from HeartStone's scanUrl: fetch HTML, extract
<img>/<video>/<audio>/<a href> candidates, classify by extension.
"""

import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

from backend.download.errors import HTTPStatusError, URLNotSupportedError

SCAN_TAGS = re.compile(r'<(?:img|video|audio|source)\b[^>]*\bsrc\s*=\s*"([^"]+)"', re.IGNORECASE)
SCAN_LINKS = re.compile(
    r'href\s*=\s*"([^"]+\.(?:mp4|webm|mkv|mov|mp3|wav|m4a|webp|jpg|jpeg|png|gif|zip|pdf))"',
    re.IGNORECASE,
)

MEDIA_EXTS = (
    "mp4",
    "webm",
    "mkv",
    "mov",
    "avi",
    "flv",
    "m4v",
    "mp3",
    "wav",
    "aac",
    "flac",
    "ogg",
    "m4a",
)
IMAGE_EXTS = ("webp", "jpg", "jpeg", "png", "gif", "bmp", "heic", "avif")
DOC_EXTS = ("zip", "pdf", "doc", "docx", "txt", "md", "srt", "vtt")


@dataclass
class ScannedAsset:
    url: str
    name: str
    kind: str  # video | audio | image | document


@dataclass
class GenericSource:
    client: httpx.AsyncClient

    async def scan_page(self, page_url: str, limit: int = 100) -> list[ScannedAsset]:
        """Extract media/document assets from an HTML page."""
        from backend.download.parser import is_public_http_url

        if not is_public_http_url(page_url):
            raise URLNotSupportedError(f"unsupported URL: {page_url[:64]}")
        # Redirects are re-validated hop by hop: a public page may 302 to
        # 169.254.169.254 etc. (AXIOM §8.1 — every hop is user input).
        resp = await self.client.get(page_url, follow_redirects=False)
        for _ in range(5):
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location")
                if not location:
                    break
                next_url = urljoin(page_url, location)
                if not is_public_http_url(next_url):
                    raise URLNotSupportedError(f"redirect blocked: {next_url[:64]}")
                page_url = next_url
                resp = await self.client.get(next_url, follow_redirects=False)
                continue
            break
        if resp.status_code >= 400:
            raise HTTPStatusError(resp.status_code)
        html = resp.text
        found: list[str] = list(re.findall(SCAN_TAGS, html)) + list(re.findall(SCAN_LINKS, html))
        assets: list[ScannedAsset] = []
        seen: set[str] = set()
        for raw in found:
            if raw.startswith(("data:", "javascript:", "#", "blob:")):
                continue
            absolute = urljoin(page_url, raw)
            if urlparse(absolute).scheme not in ("http", "https"):
                continue
            if absolute in seen:
                continue
            seen.add(absolute)
            ext = absolute.rsplit(".", 1)[-1].lower() if "." in absolute.rsplit("/", 1)[-1] else ""
            kind = _classify(ext)
            if kind is None:
                continue
            assets.append(
                ScannedAsset(
                    url=absolute,
                    name=absolute.rsplit("/", 1)[-1] or absolute,
                    kind=kind,
                )
            )
            if len(assets) >= limit:
                break
        return assets

    def describe(self, url: str) -> dict:
        """Direct link: no negotiation, one implicit 'original' format."""
        name = urlparse(url).path.rsplit("/", 1)[-1] or "download"
        ext = name.rsplit(".", 1)[-1] if "." in name else ""
        kind = _classify(ext) or "video"
        return {
            "title": name,
            "formats": [
                {"format_id": "original", "label": "原始文件", "ext": ext or "bin", "kind": kind}
            ],
        }


def _classify(ext: str) -> str | None:
    if not ext:
        return None
    if ext in MEDIA_EXTS:
        return "audio" if ext in ("mp3", "wav", "aac", "flac", "ogg", "m4a") else "video"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in DOC_EXTS:
        return "document"
    return None
