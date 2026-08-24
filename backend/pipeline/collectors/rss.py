"""RSS/Atom 通用文本源（v0.22 非破坏性扩展）。

定位：文本型 feed（博客/专栏/资讯）→ text_only 条目——与 AI 故事源同为
零凭证供料通道。只承诺文本：不提取媒体（媒体型 feed 不在本源范围）。

订阅配置（settings.pipeline_rss_feeds，每行一条）::

    名称|https://example.com/feed.xml

通道格式：``rss/<名称>``；名称未配置 → RuntimeError（走失败分类+冷却，
设置页可见错误信息）。解析复用 reddit.py 的 ET 模式（Atom/RSS2 双格式）；
正文取 content:encoded > description > summary 首个非空，剥 HTML 标签后
≥50 字才入库（对齐文字帖门槛），超长截断。
"""

import hashlib
import html
import ipaddress
import re
import socket
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlparse

import httpx

from backend.config import settings as app_settings
from backend.pipeline.collectors.base import RawPost, SourceCollector

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_MIN_TEXT_CHARS = 50
_MAX_TEXT_CHARS = 4000
_ATOM = "{http://www.w3.org/2005/Atom}"
_CONTENT_NS = "{http://www.w3.org/2005/Atom}"

_TAG_RE = re.compile(r"<[^>]+>")


def is_blocked_host(hostname: str) -> bool:
    """SSRF 防护（AXIOM §8.1）：主机名解析到私网/环回/链路本地/保留段 → 拒绝。

    纯函数便于单测；DNS 解析在调用方做（getaddrinfo 全部结果逐一校验，
    防止多 A 记录部分公网部分内网的绕过）。
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except (socket.gaierror, UnicodeError):
        return True  # 解析失败按拒绝处理
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return True
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return True
    return False


def assert_public_http_url(url: str) -> None:
    """仅放行 http(s) 且解析后不含内网地址的 URL；违规 RuntimeError。"""
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise RuntimeError(f"RSS 订阅 URL 非法（仅支持 http/https）: {url[:120]}")
    if parsed.hostname in ("localhost",) or parsed.hostname.endswith(".local"):
        raise RuntimeError(f"RSS 订阅禁止本机地址: {url[:120]}")
    if is_blocked_host(parsed.hostname):
        raise RuntimeError(
            f"RSS 订阅地址解析到内网/保留 IP，已拒绝（SSRF 防护）: {url[:120]}"
        )


def parse_feeds_config(raw: str) -> dict[str, str]:
    """`名称|URL` 行配置 → {名称: URL}；空行/# 注释跳过。"""
    feeds: dict[str, str] = {}
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        name, url = line.split("|", 1)
        name, url = name.strip(), url.strip()
        if name and url:
            feeds[name] = url
    return feeds


def _strip_html(raw: str) -> str:
    text = html.unescape(_TAG_RE.sub("", raw or ""))
    return re.sub(r"\s+", " ", text).strip()


def _entry_text(entry, ns: str) -> str:
    for tag in (f"{ns}content", f"{ns}summary", f"{ns}description"):
        node = entry.find(tag)
        if node is not None and (node.text or "").strip():
            return _strip_html(node.text)
    # RSS2 无命名空间子节点
    for tag in ("content:encoded", "description"):
        node = entry.find(tag)
        if node is not None and (node.text or "").strip():
            return _strip_html(node.text)
    return ""


def _entry_id(link: str, title: str) -> str:
    basis = link or title
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]  # noqa: S324 — 去重指纹非安全用途


def _parse_feed(text: str, feed_name: str) -> list[RawPost]:
    """Atom/RSS2 → RawPost 列表；单条过短跳过，解析失败抛错。"""
    root = ET.fromstring(text)
    posts: list[RawPost] = []
    now = time.time()

    atom_entries = root.findall(f"{_ATOM}entry")
    if atom_entries:
        for entry in atom_entries:
            link_node = entry.find(f"{_ATOM}link")
            link = (link_node.get("href") or "").strip() if link_node is not None else ""
            title_node = entry.find(f"{_ATOM}title")
            title = _strip_html(title_node.text or "") if title_node is not None else ""
            body = _entry_text(entry, _ATOM)
            posts.append((link, title, body))
    else:
        for item in root.iter("item"):
            link_node = item.find("link")
            link = (link_node.text or "").strip() if link_node is not None else ""
            title = _strip_html(item.findtext("title") or "")
            body = _entry_text(item, "")
            posts.append((link, title, body))

    result: list[RawPost] = []
    for link, title, body in posts:
        if len(body) < _MIN_TEXT_CHARS:
            continue
        result.append(
            RawPost(
                source_id=_entry_id(link, title),
                title=title[:300] or body[:40],
                source_url=link,
                author=f"rss:{feed_name}",
                created_utc=now,
                is_video=False,
                item_type="text_only",
                selftext=body[:_MAX_TEXT_CHARS],
            )
        )
    return result


class RssFeedCollector(SourceCollector):
    """通用 RSS/Atom 文本采集器（无状态，feed 表来自 settings）。"""

    name = "rss"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": _UA}, timeout=20, follow_redirects=True,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def collect(self, ctx, channel: str, limit: int) -> list[RawPost]:
        _, feed_name = channel.split("/", 1) if "/" in channel else ("", channel)
        feed_name = feed_name.strip()
        feeds = parse_feeds_config(getattr(app_settings, "pipeline_rss_feeds", "") or "")
        if feed_name not in feeds:
            known = ", ".join(sorted(feeds)) or "无"
            raise RuntimeError(
                f"RSS 订阅 '{feed_name}' 未配置——请在设置页 pipeline_rss_feeds "
                f"添加 `名称|URL` 行（当前已配置: {known}）"
            )
        assert_public_http_url(feeds[feed_name])
        resp = await self._client.get(feeds[feed_name])
        if resp.status_code in (403, 429):
            # 与 reddit 同语义：被拒走长冷却
            raise RuntimeError(f"RSS 源拒绝访问 (HTTP {resp.status_code}): {feed_name}")
        resp.raise_for_status()
        posts = _parse_feed(resp.text, feed_name)
        return posts[: max(1, int(limit or 10))]
