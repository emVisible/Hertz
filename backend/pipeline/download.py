"""下载韧性（v0.2.9，参考原项目 Autarkeia pipeline/download.py）。

解决「内容项 failed: download failed: HTTP_404」的根因：Reddit CDN 的
v.redd.it 分享 URL 经常 404（帖子删除/死 id/HLS-only），单 URL 直下
必然整条失败。本模块提供：
- media_candidates：候选链（DASH_720.mp4 → 原 URL → permalink 兜底），逐个尝试；
  排除 DASHPlaylist.mpd/HLS_720.mpd 清单候选——Hertz 无 MPD 解析器，
  直下会把 XML 清单误存为成片（v0.2.9 查漏补缺）
- download_headers：白名单域附加 Referer/Origin/Sec-Fetch（Reddit CDN 要求）
- is_dead_reddit_media：死 id 预筛（采集时直接跳过，不下车）
- CDN 熔断：连续 403 达阈值 → 进程内熔断，保护队列不逐条 FAILED
- download_pacing：条间延迟 + 抖动（防节奏整齐被封）
- 静图防护：大小上限 / 最小字节
"""

import asyncio
import logging
import random
import time
from urllib.parse import urlparse

from backend.config import settings
from backend.download.engine import host_trusted, is_safe_media_url
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

# 静图防护（参考原项目 download_still_image）
STILL_MAX_BYTES = 40 * 1024 * 1024
STILL_MIN_BYTES = 256

_REDDIT_REFERER = "https://www.reddit.com/"

# ---- URL 候选链 ----


def _reddit_dash_url(url: str) -> list[str]:
    """v.redd.it/{id} → DASH 视频候选（只认 v.redd.it，且仅直接视频文件——
    清单（.mpd/.m3u8）需要解析器，Hertz 不引入，宁缺勿滥）。"""
    p = urlparse(url)
    if p.hostname != "v.redd.it":
        return []
    vid = (p.path or "").strip("/").split("/")[0]
    if not vid:
        return []
    return [f"https://v.redd.it/{vid}/DASH_720.mp4"]


def media_candidates(
    url: str, permalink: str | None = None, checker=is_safe_media_url
) -> list[str]:
    """按顺序生成下载候选（去重 + SSRF 过滤），逐候选尝试。

    checker 参数化（AXIOM §1.2）：步骤在 loopback 逃生（测试/本地源）时
    传入 scheme-only 校验，候选过滤与最终下载同一把尺。
    """
    candidates: list[str] = []
    for u in (url, permalink):
        if not u or not checker(u):
            continue
        for cand in [*_reddit_dash_url(u), u]:
            if cand not in candidates:
                candidates.append(cand)
    return candidates


def looks_like_manifest(content: bytes) -> bool:
    """下载内容嗅探：XML/M3U 清单文本（误下 DASHPlaylist/HLS 时的兜底）。"""
    head = content[:512].lstrip().lower()
    return head.startswith(b"<?xml") or head.startswith(b"#extm3u")


def looks_like_html(content: bytes) -> bool:
    """HTML 页面（v0.3.1）：候选链可能把 v.redd.it/{id} 分享页当媒体下载。"""
    head = content[:512].lstrip().lower()
    return head.startswith(b"<!doctype") or head.startswith(b"<html")


# ---- 请求头 ----


def download_headers(url: str) -> dict[str, str]:
    """白名单媒体域附加 Reddit 请求头（防重定向泄漏：仅对白名单域）。

    参考原项目 _http_headers：UA + Referer + Origin + Sec-Fetch-*。
    """
    p = urlparse(url)
    host = (p.hostname or "").lower()

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
        )
    }
    if host_trusted(host) and ("reddit" in host or "redd.it" in host):
        headers.update({
            "Referer": _REDDIT_REFERER,
            "Origin": "https://www.reddit.com",
            "Accept": "*/*",
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        })
        # v0.8.1 Reddit Cookie 方案（参考原项目）：登录 Cookie 解锁 CDN 403
        try:
            from backend.pipeline.reddit_cookies import cookie_header_for_http

            cookie = cookie_header_for_http()
            if cookie:
                headers["Cookie"] = cookie
        except Exception:  # noqa: BLE001 — cookie 读取失败不影响匿名链
            pass
    return headers


# ---- 死 id 预筛（参考原项目 _invalid_collect_media） ----


def is_dead_reddit_media(url: str, permalink: str | None, source_id: str | None) -> bool:
    """已知必死媒体：permalink 不是 /comments/ 详情页的 v.redd.it 视频、
    Pullpush/RSS 死 id（1f1 结尾且无详情页）。命中 → 采集时跳过。

    v0.8.1 参考原项目 _invalid_collect_media：**permalink 本身是 v.redd.it**
    （RSS 视频帖 link 直接指向媒体而非评论区）→ 视为死（无详情页可解析）。
    """
    has_comments = "/comments/" in (permalink or "")
    if "v.redd.it" in (url or "") and not has_comments:
        return True
    if "v.redd.it" in (permalink or "") and "/comments/" not in (permalink or ""):
        return True  # permalink 误存媒体链接
    if (source_id or "").endswith("1f1") and not has_comments:
        return True
    return False


# ---- CDN 熔断（参考原项目 _cdn_circuit_open/_trip_cdn_circuit） ----


_cdn_403_count = 0
_cdn_until = 0.0


def _cdn_403_threshold() -> int:
    return int(getattr(settings, "pipeline_cdn_circuit_403", 3))


def _cdn_cooldown() -> int:
    return int(getattr(settings, "pipeline_cdn_circuit_cooldown", 600))


def cdn_circuit_open() -> bool:
    """熔断中：下载步骤跳过条目（保持状态不 FAILED），保护整条队列。"""
    if _cdn_until <= 0:
        return False
    return time.monotonic() < _cdn_until


def cdn_circuit_remaining() -> int:
    return max(int(_cdn_until - time.monotonic()), 0) if _cdn_until > 0 else 0


def trip_cdn_circuit() -> bool:
    """遇 403 记账；连续达阈值 → 打开熔断。返回是否刚触发熔断。"""
    global _cdn_403_count, _cdn_until
    _cdn_403_count += 1
    if _cdn_403_count >= _cdn_403_threshold():
        _cdn_until = time.monotonic() + _cdn_cooldown()
        logger.warning(
            "CDN circuit tripped: %d consecutive 403, cooling %ds",
            _cdn_403_count, _cdn_cooldown(),
        )
        return True
    return False


def reset_cdn_circuit() -> None:
    """非 403 结果重置连续计数（成功/404/网络错误都算非 403）。"""
    global _cdn_403_count
    _cdn_403_count = 0


# ---- 下载资源冷却（v0.3.6 冰川式，参考原项目 CDN 熔断的持久化扩展） ----
#
# 进程内熔断（上）保护「本轮队列」；这里是**域级**持久冷却——下载 403 按
# 媒体域（v.redd.it / i.redd.it / www.youtube.com…）冻结，指数退避落库，
# 重启不丢。冷却中的域整批跳过（条目保持 discovered 不 FAILED），
# 避免每次 run 都反复打被封锁的 CDN。域内任一下载成功即解冻。


def domain_of(url: str) -> str:
    from urllib.parse import urlparse

    return (urlparse(url).hostname or "").lower()


def _cooldown_base() -> int:
    return int(getattr(settings, "pipeline_download_cooling_base_seconds", 300))


def _cooldown_max() -> int:
    return int(getattr(settings, "pipeline_download_cooling_max_seconds", 7200))


def _cooldown_duration(level: int) -> int:
    """指数退避：base × 2^(level-1)，封顶 max。"""
    return min(_cooldown_base() * (2 ** max(level - 1, 0)), _cooldown_max())


async def resource_cooldown_left(url: str) -> int:
    """媒体域冰封剩余秒数（>0 = 冷却中，跳过该域所有下载）。"""
    from sqlalchemy import select

    from backend.models.pipeline import ResourceCooldown

    domain = domain_of(url)
    if not domain:
        return 0
    try:
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(ResourceCooldown).where(ResourceCooldown.domain == domain)
                )
            ).scalar_one_or_none()
            if row is None:
                return 0
            left = int(row.until_epoch - time.time())
            return max(left, 0)
    except Exception:  # noqa: BLE001 — 冷却查询失败按未冷却处理
        return 0


async def note_resource_failure(url: str, *, error: str = "") -> int:
    """403 记账：媒体域指数退避冷却。返回新冷却时长（秒）。"""
    from sqlalchemy import select

    from backend.models.pipeline import ResourceCooldown

    domain = domain_of(url)
    if not domain:
        return 0
    try:
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(ResourceCooldown).where(ResourceCooldown.domain == domain)
                )
            ).scalar_one_or_none()
            if row is None or row.until_epoch < time.time():
                level = 1 if row is None else row.fail_level + 1
            else:
                level = row.fail_level + 1
            duration = _cooldown_duration(level)
            if row is None:
                row = ResourceCooldown(
                    domain=domain, fail_level=level,
                    until_epoch=time.time() + duration,
                )
                session.add(row)
            else:
                row.fail_level = level
                row.until_epoch = time.time() + duration
            await session.commit()
        logger.warning(
            "resource cooldown: %s frozen %ds (level %d)%s",
            domain, duration, level, f" — {error[:100]}" if error else "",
        )
        return duration
    except Exception:  # noqa: BLE001 — 记账失败不阻塞下载主流程
        return 0


async def clear_resource_cooldown(url: str) -> None:
    """域内下载成功 → 解冻该媒体域。"""
    from sqlalchemy import select

    from backend.models.pipeline import ResourceCooldown

    domain = domain_of(url)
    if not domain:
        return
    try:
        async with session_factory() as session:
            row = (
                await session.execute(
                    select(ResourceCooldown).where(ResourceCooldown.domain == domain)
                )
            ).scalar_one_or_none()
            if row is not None:
                await session.delete(row)
                await session.commit()
    except Exception:  # noqa: BLE001 — 解冻失败无害
        return


# ---- 条间节奏（参考原项目 _sleep_jitter） ----


_last_download_at = 0.0


async def download_pacing() -> None:
    """条间延迟 ±15% 抖动（首条不睡）。"""
    global _last_download_at
    base = float(getattr(settings, "pipeline_download_delay_seconds", 1.2))
    if base <= 0 or _last_download_at <= 0:
        _last_download_at = time.monotonic()
        return
    elapsed = time.monotonic() - _last_download_at
    delay = base * (0.85 + 0.3 * random.random())
    if elapsed < delay:
        await asyncio.sleep(delay - elapsed)
    _last_download_at = time.monotonic()
