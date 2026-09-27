"""Reddit 媒体签名直链（v0.3.7）。

匿名下载 v.redd.it 被 CDN 403 Blocked（IP 封锁）时，用 OAuth 凭证走
官方 comments API 解析帖子媒体元数据，取带签名的 fallback_url /
oauth_media_url 直链——官方播放器同款路径，CDN 对签名链接放行。

依赖 collectors/reddit.py 的 ensure_reddit_token（采集/下载共用 token）。
未配置 OAuth 凭证 → 返回 None（保持现有匿名候选链，不增加失败面）。
"""

import logging

import httpx

from backend.pipeline.collectors.reddit import ensure_reddit_token

logger = logging.getLogger(__name__)

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


async def _resolve_via_client(client: httpx.AsyncClient, source_id: str) -> str | None:
    """打 oauth.reddit.com/comments/{id}，从 post 媒体元数据取签名直链。"""
    resp = await client.get(
        f"https://oauth.reddit.com/comments/{source_id}",
        params={"limit": 1, "raw_json": 1},
    )
    if resp.status_code in (401, 403):
        return None  # token 失效由调用方 invalidate 后重试
    if resp.status_code != 200:
        return None
    body = resp.json()
    if not isinstance(body, list) or not body:
        return None
    # 第一个 listing 的 children 里是帖子本身
    children = (body[0].get("data") or {}).get("children") or []
    if not children:
        return None
    post = children[0].get("data") or {}
    media = post.get("media") or {}
    rv = media.get("reddit_video") or {}
    # 签名直链：fallback_url（DASH_720.mp4 带 token）优先，
    # oauth_media_url（官方播放器 URL）兜底
    for key in ("fallback_url", "oauth_media_url", "hls_url"):
        signed = rv.get(key) or (media.get("oauth_media_url") if key == "oauth_media_url" else None)
        if isinstance(signed, str) and signed.startswith("http"):
            return signed
    # media 顶层兜底：scrubber_media_url / oauth_media_url
    for key in ("oauth_media_url", "scrubber_media_url"):
        signed = media.get(key)
        if isinstance(signed, str) and signed.startswith("http"):
            return signed
    return None


async def resolve_direct_video(
    source_id: str | None,
    media_url: str | None,
    client: httpx.AsyncClient | None = None,
) -> str | None:
    """OAuth 签名直链解析（v0.3.7）。

    参数：帖子 source_id + 原 media_url（v.redd.it 判定用）。
    返回签名直链；未配置 OAuth / 非 v.redd.it / 解析失败 → None（匿名链兜底）。
    client 可注入（测试用 FakeTransport）。
    """
    from urllib.parse import urlparse

    if not media_url or (urlparse(media_url).hostname or "") != "v.redd.it":
        return None
    if not source_id:
        return None
    token = await ensure_reddit_token()
    if not token:
        return None
    from backend.infrastructure.net import system_proxy

    proxy = system_proxy()

    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            headers={"User-Agent": _UA, "Authorization": f"Bearer {token}"},
            timeout=20,
            proxy=proxy,
        )
    else:
        client.headers["Authorization"] = f"Bearer {token}"  # 注入 client 同样补齐
    try:
        signed = await _resolve_via_client(client, source_id)
        if signed:
            return signed
        # 401/403 → token 可能失效，重取一次再试
        from backend.pipeline.collectors.reddit import invalidate_reddit_token

        invalidate_reddit_token()
        token = await ensure_reddit_token()
        if not token:
            return None
        client.headers["Authorization"] = f"Bearer {token}"
        return await _resolve_via_client(client, source_id)
    finally:
        if owns_client:
            await client.aclose()


def _signed_url_safe(url: str) -> bool:
    """签名直链仍须过 SSRF 校验（AXIOM §8.1）：只放行 reddit 媒体域。"""
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    return host in ("v.redd.it", "i.redd.it", "preview.redd.it") or host.endswith(
        (".redditmedia.com", ".redd.it")
    )
