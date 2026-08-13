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


class CollectBlockedError(RuntimeError):
    """Reddit 拒绝服务（403 Blocked）——长冷却，避免连打触发封禁（冰川式）。"""


class CollectRateLimitedError(RuntimeError):
    """频率限制（429）——中等冷却；持续限流会触发熔断。"""


class CollectNetworkError(RuntimeError):
    """网络层失败（连接拒绝/超时）——短冷却，网络恢复后快速重试。

    冰川式原则：网络抖动与平台拒绝分开记账，避免「代理断了一下 → 2h 熔断」。
    """


def _classify_http(exc: httpx.HTTPError, detail: str) -> RuntimeError:
    """httpx 异常 → 分类异常（含类型名，解决网络层异常 str() 为空的盲区）。"""
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout)):
        return CollectNetworkError(
            f"Reddit 连接失败: {detail}（{type(exc).__name__}）——请检查网络或代理设置"
        )
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code if exc.response is not None else 0
        if code == 429:
            return CollectRateLimitedError(f"Reddit 限流 (HTTP 429): {detail}")
        if code in (401, 403):
            return CollectBlockedError(f"Reddit 拒绝访问 (HTTP {code}): {detail}")
    return CollectNetworkError(f"Reddit 请求失败: {detail}（{type(exc).__name__}）")


def _parse_channel(channel: str) -> tuple[str, str]:
    """channel 解析：`subreddit` 或 `subreddit:sort`。

    旧配置曾把排序词（如 "hot"）当作 subreddit——r/hot 近乎无内容，
    且错误的源会把匿名 403 甩给正常版块；现在显式报配置错误。
    """
    raw = (channel or "").strip()
    sort = raw.split(":", 1)[1] if ":" in raw else ""
    sub = raw.split(":", 1)[0].strip("/")
    if not sub:
        raise RuntimeError("采集通道缺少 subreddit（channel 为空）")
    # 无冒号的排序词 = 旧配置缺陷（pipeline_sources: ["hot"]）——提示真实版块名
    if ":" not in raw and sub in _SORTS:
        raise RuntimeError(
            f"采集源 '{sub}' 是排序词不是 subreddit——请配置真实版块名，"
            f"如 'Damnthatsinteresting'；格式为 'subreddit' 或 'subreddit:{'|'.join(_SORTS)}'"
        )
    if sort not in _SORTS:
        sort = random.choice(_SORTS)
    return sub, sort


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


# ---- Reddit OAuth token（v0.3.5 起采集/下载共用，模块级缓存） ----


_token_holder: dict[str, str | None] = {"token": None}


def invalidate_reddit_token() -> None:
    """token 失效（401/403）→ 下次请求重新换取。"""
    _token_holder["token"] = None


async def ensure_reddit_token() -> str | None:
    """OAuth 凭证（设置页配置）→ Bearer token；未配置返回 None（走匿名通道）。

    采集与下载（v0.3.7 签名直链）共用：模块级缓存 + 失效重取。
    """
    client_id = settings.pipeline_reddit_client_id
    client_secret = settings.pipeline_reddit_client_secret
    if not (client_id and client_secret):
        return None
    if _token_holder["token"]:
        return _token_holder["token"]
    basic = urllib.parse.quote(client_id, safe="") + ":" + urllib.parse.quote(
        client_secret, safe=""
    )
    async with httpx.AsyncClient(
        headers={"User-Agent": _UA},
        timeout=20,
        proxy=_system_proxy(),
    ) as client:
        resp = await client.post(
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
    token = str(body.get("access_token") or "")
    if not token:
        raise RuntimeError("Reddit OAuth 响应缺少 access_token")
    _token_holder["token"] = token
    return token


def classify_media(url: str, is_video: bool, extra: dict) -> str:
    """Route a post to the right production pipeline.

    video_raw: direct video file / v.redd.it clip (default when unsure)
    image_gallery: one or more still images
    text_only: self post without media

    v0.8.8 修复：reddit.com/gallery/{id} 多图帖此前落入 fallback 被标成
    video_raw（JSON 通道 url 字段为 gallery 页链接）——显式识别为图片。
    """
    if is_video or "v.redd.it" in url or "/video" in url:
        return "video_raw"
    lowered = url.lower()
    if any(lowered.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".gif", ".webp")):
        return "image_gallery"
    if "/gallery/" in lowered:
        return "image_gallery"
    if not url:
        return "text_only"
    return "video_raw"


class RedditCollector(SourceCollector):
    name = "reddit"
    # v0.8.9 AXIOM 28：最近一次成功采集走的通道（oauth/json/rss）——
    # 由 collect() 各通道设置，run_collect 写入 SourceState.last_strategy
    _last_strategy: str = "json"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        proxy = _system_proxy()
        self._proxy = proxy
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": _UA},
            timeout=20,
            proxy=proxy,
        )
        # v0.8.1 Cookie 方案（参考原项目）：登录 Cookie 降低采集 403 概率
        try:
            from backend.pipeline.reddit_cookies import cookie_header_for_http

            cookie = cookie_header_for_http()
            if cookie:
                self._client.headers["Cookie"] = cookie
        except Exception:  # noqa: BLE001 — cookie 不可用不影响匿名采集
            pass

    async def aclose(self) -> None:
        await self._client.aclose()

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        sub, sort = _parse_channel(channel)
        token = await ensure_reddit_token()
        if token:
            # 认证通道（v0.3.5）：官方 API 对匿名 403 Blocked 免疫
            self._last_strategy = "oauth"  # v0.8.9 AXIOM 28：通道可观测
            return await self._collect_oauth(sub, sort, limit, token)
        try:
            self._last_strategy = "json"
            return await self._collect_json(sub, sort, limit)
        except _JsonRejectedError as exc:
            # JSON 被拒（403/429）→ RSS 兜底（v0.3.1，参考原项目 RSS 路径）：
            # 匿名 JSON 易被 Blocked，RSS 更宽容；仍失败则分类报错（走健康度/冷却）
            logger.warning("JSON rejected for r/%s (%s) — falling back to RSS", sub, exc)
            try:
                self._last_strategy = "rss"
                return await self._collect_rss(sub, sort, limit)
            except httpx.HTTPError as rss_exc:
                raise _classify_http(
                    rss_exc,
                    f"JSON {exc}；RSS 兜底也失败: {rss_exc}。"
                    "若持续被拒，请在设置页配置 Reddit OAuth 凭证（client_id/secret）",
                ) from rss_exc
        except httpx.HTTPError as exc:
            raise _classify_http(exc, str(exc)) from exc

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
            invalidate_reddit_token()  # token 失效 → 下次重取
            raise CollectBlockedError(
                f"Reddit OAuth 通道被拒 (HTTP {resp.status_code})——"
                "token 可能已失效，请重试；或检查 client_id/client_secret"
            )
        if resp.status_code == 429:
            raise CollectRateLimitedError("Reddit OAuth 限流 (HTTP 429)")
        try:
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise _classify_http(exc, str(exc)) from exc
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
            # 网络层失败直接分类（不再走 RSS 兜底——RSS 同样会失败）
            raise _classify_http(exc, str(exc)) from exc
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
        try:
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise _classify_http(exc, f"RSS {exc}") from exc
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
        # 媒体从 content:encoded 正则提取（RSS 不直接给 media_url）
        content = ""
        for tag in (f"{_CONTENT_NS}content", f"{_CONTENT_NS}summary"):
            node = entry.find(tag)
            if node is not None:
                content = node.text or ""
                break
        # v0.8.8 修复：v.redd.it href 时旧逻辑用媒体 ID（13 位）构造
        # comments/{id}/——媒体 ID ≠ 帖子 ID（实测 v.redd.it 302 → /video/{id}），
        # 构造链接 404 无法访问原帖。改为：
        #   1) 优先从 content:encoded 提取真正 /r/{sub}/comments/{post_id}/ 链接
        #   2) 提取不到 → 用 https://www.reddit.com/video/{vid}/（有效视频页）
        source_id = ""
        if "/comments/" in permalink:
            m = re.search(r"/comments/([a-z0-9]+)/", permalink)
            source_id = m.group(1) if m else ""
            if not source_id:
                source_id = permalink.rstrip("/").rsplit("/", 1)[-1]
        elif "v.redd.it" in permalink:
            vid = permalink.rstrip("/").rsplit("/", 1)[-1]
            if vid and vid != "v.redd.it":
                real = re.search(r"/r/[\w]+/comments/([\w]+)/", content or "")
                if real:
                    source_id = real.group(1)
                    sub = re.search(r"/r/([\w]+)/", content or "")
                    permalink = (
                        f"https://www.reddit.com/r/{sub.group(1)}/comments/{source_id}/"
                        if sub
                        else f"https://www.reddit.com/comments/{source_id}/"
                    )
                else:
                    # 无详情页可循：视频页是唯一有效入口（实测 v.redd.it 302 目标）
                    source_id = vid
                    permalink = f"https://www.reddit.com/video/{vid}/"
        if not source_id:
            source_id = permalink.rstrip("/").rsplit("/", 1)[-1]
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

