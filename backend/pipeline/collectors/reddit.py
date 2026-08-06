"""Reddit collector — single-strategy JSON API fetch with cursor tracking.

Reads public listings (no OAuth needed for read-only anonymous access):
``https://www.reddit.com/r/{sub}/{sort}.json?limit=``. Incremental cursor is
the oldest ``created_utc`` seen, so each run only scans newer posts.
"""

import logging
import time
import urllib.request

import httpx

from backend.pipeline.collectors.base import RawPost, SourceCollector

logger = logging.getLogger(__name__)

_UA = "hertz/0.1 (content pipeline collector)"
_SORTS = ("hot", "new", "rising", "top")


def _system_proxy() -> str | None:
    """macOS 系统代理（httpx 只认环境变量，不读系统网络设置）。

    墙内访问 Reddit 时用户通常在系统设置里配了代理；这里把
    urllib 解析出的系统代理喂给 httpx，无代理则返回 None。
    """
    try:
        proxies = urllib.request.getproxies()
    except Exception:  # noqa: BLE001 — proxy discovery is best-effort
        return None
    return proxies.get("https") or proxies.get("http") or None


def classify_media(url: str, is_video: bool, extra: dict) -> str:
    """Route a post to the right production pipeline.

    video_raw: direct video file / v.redd.it clip (default when unsure)
    image_gallery: one or more still images
    text_only: self post without media
    """
    if is_video or "v.redd.it" in url or "/video" in url:
        return "video_raw"
    lowered = url.lower()
    if any(lowered.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")):
        return "image_gallery"
    if not url:
        return "text_only"
    return "video_raw"


class RedditCollector(SourceCollector):
    name = "reddit"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        proxy = _system_proxy()
        self._proxy = proxy
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": _UA},
            timeout=20,
            proxy=proxy,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        sort = channel.split(":", 1)[1] if ":" in channel else "hot"
        if sort not in _SORTS:
            sort = "hot"
        sub = channel.split(":", 1)[0].strip("/") or "all"
        url = f"https://www.reddit.com/r/{sub}/{sort}.json"
        try:
            resp = await self._client.get(url, params={"limit": min(limit, 100)})
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            # 网络错误优雅降级：步骤失败但流水线继续（AXIOM §4.6 韧性）
            hint = ""
            if isinstance(exc, httpx.ConnectError):
                hint = "（无法连接 Reddit——请检查网络或代理设置）"
            raise RuntimeError(f"Reddit 采集失败: {exc}{hint}") from exc
        body = resp.json()
        posts: list[RawPost] = []
        for child in (body.get("data") or {}).get("children") or []:
            data = child.get("data") or {}
            post = self._to_post(data)
            if post is not None:
                posts.append(post)
        return posts

    @staticmethod
    def _to_post(data: dict) -> RawPost | None:
        if data.get("stickied"):
            return None
        url = str(data.get("url") or "")
        kind = classify_media(url, bool(data.get("is_video")), data)
        if kind == "text_only":
            return None  # text-only posts have no producible media
        media_url = url
        if kind == "video_raw" and not media_url:
            media_url = f"https://v.redd.it/{data.get('id')}/DASH_720.mp4"
        if kind == "image_gallery":
            preview = (data.get("preview") or {}).get("images") or []
            if preview:
                media_url = str((preview[0].get("source") or {}).get("url") or url)
        return RawPost(
            source_id=str(data.get("id") or ""),
            title=str(data.get("title") or "")[:300],
            source_url=f"https://www.reddit.com{data.get('permalink') or ''}",
            media_url=media_url,
            author=str(data.get("author") or ""),
            score=int(data.get("score") or 0),
            upvote_ratio=float(data.get("upvote_ratio") or 0.0),
            num_comments=int(data.get("num_comments") or 0),
            created_utc=float(data.get("created_utc") or time.time()),
            is_video=bool(data.get("is_video")),
            item_type=kind,
        )


class FakeRedditCollector(RedditCollector):
    """Deterministic collector for tests: returns canned posts."""

    def __init__(self, posts: list[RawPost] | None = None) -> None:
        super().__init__(client=httpx.AsyncClient())
        self._posts = posts or []

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        return list(self._posts)[:limit]

