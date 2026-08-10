"""Reddit collector — OAuth JSON API with anonymous RSS fallback (v0.3.5).

Primary: ``oauth.reddit.com/r/{sub}/{sort}`` with a Bearer token (official
API). Anonymous www.reddit.com JSON 极易被 403 Blocked（TLS/IP 指纹），
配置 ``pipeline_reddit_client_id/secret``（设置页）即自动启用认证通道；
无凭证时降级匿名 JSON → RSS 兜底（参考原项目 RSS 路径）。
媒体 URL 从 RSS 的 content:encoded 中正则提取（v.redd.it / i.redd.it）。
"""

import logging
import random
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import httpx

from backend.config import settings
from backend.pipeline.collectors.base import RawPost, SourceCollector

logger = logging.getLogger(__name__)

# 真实浏览器 UA（v0.3.1）：自定义 UA 的匿名 JSON 请求会被 Reddit 403 Blocked
_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_SORTS = ("hot", "new", "rising", "top")

# RSS content:encoded 中的媒体链接（v.redd.it 视频 / i.redd.it 图 / preview）
_MEDIA_RE = re.compile(
    r"https://(?:v\.redd\.it/[A-Za-z0-9]+(?:/[A-Za-z0-9_.]+)?|"
    r"i\.redd\.it/[A-Za-z0-9_.]+\.(?:jpg|jpeg|png|gif|webp)|"
    r"preview\.redd\.it/[^\s\"'<>]+\.(?:jpg|jpeg|png|gif|webp))",
    re.IGNORECASE,
)
_XMLNS = {"atom": "http://www.w3.org/2005/Atom", "media": "http://search.yahoo.com/mrss/"}
_CONTENT_NS = "{http://www.w3.org/2005/Atom}"


class _JsonRejectedError(RuntimeError):
    """匿名 JSON 被 Reddit 拒绝（403/429）——触发 RSS 兜底。"""

    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


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


def _b64(data: bytes) -> bytes:
    """Local base64 to keep this module free of import-time churn."""
    import base64

    return base64.b64encode(data)


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
        self._token: str | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _ensure_token(self) -> str | None:
        """OAuth 凭证（设置页配置）→ Bearer token；未配置返回 None（走匿名通道）。"""
        client_id = settings.pipeline_reddit_client_id
        client_secret = settings.pipeline_reddit_client_secret
        if not (client_id and client_secret):
            return None
        if self._token:
            return self._token
        basic = urllib.parse.quote(client_id, safe="") + ":" + urllib.parse.quote(
            client_secret, safe=""
        )
        resp = await self._client.post(
            "https://www.reddit.com/api/v1/access_token",
            data={"grant_type": "client_credentials"},
            headers={
                "Authorization": "Basic " + _b64(basic.encode("utf-8")).decode("ascii"),
                "User-Agent": _UA,
            },
        )
        if resp.status_code != 200:
            raise RuntimeError(
                f"Reddit OAuth 换取 token 失败 (HTTP {resp.status_code})——"
                "请检查设置页的 client_id/client_secret"
            )
        body = resp.json()
        self._token = str(body.get("access_token") or "")
        if not self._token:
            raise RuntimeError("Reddit OAuth 响应缺少 access_token")
        return self._token

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        sort = channel.split(":", 1)[1] if ":" in channel else ""
        if sort not in _SORTS:
            # 排序轮换（v0.2.1，参考原项目随机化）：未显式指定时随机挑选，
            # 避免每次都打固定 hot 首页（反 429 熔断 + 供给多样化）
            sort = random.choice(_SORTS)
        sub = channel.split(":", 1)[0].strip("/") or "all"
        token = await self._ensure_token()
        if token:
            # 认证通道（v0.3.5）：官方 API 对匿名 403 Blocked 免疫
            return await self._collect_oauth(sub, sort, limit, token)
        try:
            return await self._collect_json(sub, sort, limit)
        except _JsonRejectedError as exc:
            # JSON 被拒（403/429）→ RSS 兜底（v0.3.1，参考原项目 RSS 路径）：
            # 匿名 JSON 易被 Blocked，RSS 更宽容；仍失败则如实报错（走健康度/冷却）
            logger.warning("JSON rejected for r/%s (%s) — falling back to RSS", sub, exc)
            try:
                return await self._collect_rss(sub, sort, limit)
            except httpx.HTTPError as rss_exc:
                raise RuntimeError(
                    f"Reddit 采集失败: JSON {exc}；RSS 兜底也失败: {rss_exc}。"
                    "若持续被拒，请在设置页配置 Reddit OAuth 凭证（client_id/secret）"
                ) from rss_exc

    async def _collect_oauth(
        self, sub: str, sort: str, limit: int, token: str
    ) -> list[RawPost]:
        """认证通道（v0.3.5）：oauth.reddit.com 走官方 API，匿名 403 不再命中。"""
        url = f"https://oauth.reddit.com/r/{sub}/{sort}"
        resp = await self._client.get(
            url,
            params={"limit": min(limit, 100), "raw_json": 1},
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code in (401, 403):
            self._token = None  # token 失效 → 下次重取
            raise RuntimeError(
                f"Reddit OAuth 通道被拒 (HTTP {resp.status_code})——"
                "token 可能已失效，请重试；或检查 client_id/client_secret"
            )
        try:
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Reddit OAuth 采集失败: {exc}") from exc
        body = resp.json()
        posts: list[RawPost] = []
        for child in (body.get("data") or {}).get("children") or []:
            data = child.get("data") or {}
            post = self._to_post(data)
            if post is not None:
                posts.append(post)
        return posts

    async def _collect_json(self, sub: str, sort: str, limit: int) -> list[RawPost]:
        url = f"https://www.reddit.com/r/{sub}/{sort}.json"
        resp = await self._client.get(url, params={"limit": min(limit, 100)})
        if resp.status_code in (403, 429):
            raise _JsonRejectedError(resp.status_code)
        try:
            resp.raise_for_status()
        except httpx.HTTPError as exc:
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

    async def _collect_rss(self, sub: str, sort: str, limit: int) -> list[RawPost]:
        """RSS 兜底（v0.3.1）：old.reddit.com 更宽容；媒体从 content:encoded 提取。"""
        url = f"https://old.reddit.com/r/{sub}/{sort}.rss"
        resp = await self._client.get(url, params={"limit": min(limit, 100)})
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        posts: list[RawPost] = []
        for entry in root.findall(f"{_CONTENT_NS}entry"):
            post = self._rss_to_post(entry)
            if post is not None:
                posts.append(post)
        return posts

    @classmethod
    def _rss_to_post(cls, entry) -> RawPost | None:
        def _text(tag: str) -> str:
            node = entry.find(f"{_CONTENT_NS}{tag}")
            return (node.text or "").strip() if node is not None else ""

        # Atom link 是 href 属性（无文本节点）
        link_node = entry.find(f"{_CONTENT_NS}link")
        permalink = (link_node.get("href") or "").strip() if link_node is not None else ""
        title = _text("title")
        if not permalink:
            return None
        # /comments/{id}/ 提取 source_id
        m = re.search(r"/comments/([a-z0-9]+)/", permalink)
        source_id = m.group(1) if m else permalink.rstrip("/").rsplit("/", 1)[-1]
        # 媒体从 content:encoded 正则提取（RSS 不直接给 media_url）
        content = ""
        for tag in (f"{_CONTENT_NS}content", f"{_CONTENT_NS}summary"):
            node = entry.find(tag)
            if node is not None:
                content = node.text or ""
                break
        media = _MEDIA_RE.search(content)
        media_url = media.group(0).rstrip("/") if media else ""
        kind = classify_media(media_url, "v.redd.it" in media_url, {})
        if kind == "text_only":
            return None
        created_utc = time.time()
        return RawPost(
            source_id=source_id,
            title=title[:300],
            source_url=permalink,
            media_url=media_url or None,
            author="",
            score=0,
            upvote_ratio=0.0,
            num_comments=0,
            created_utc=created_utc,
            is_video="v.redd.it" in media_url,
            item_type=kind,
        )

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

