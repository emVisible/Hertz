"""发布数据回捞（v0.4 C1）：B 站 web API 按 BV 号拉播放/互动。

数据源：api.bilibili.com/x/web-interface/view（公开统计，无需登录）。
Cookie 复用 data/core/cookies.json（biliup-cli 兼容格式）——仅当接口被反爬拦截时
才需要；403/异常一律静默（best-effort，不阻塞主流程）。

publish_json 结构（v0.4 C1）：
  {"target", "title", "bvid", "stats": {view,like,favorite,comment,share},
   "stats_at": ISO时间}
"""

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

import httpx

from backend.config import settings

logger = logging.getLogger(__name__)

_STAT_KEYS = ("view", "like", "favorite", "comment", "share")

_BVID_RE = re.compile(r"BV[0-9A-Za-z]{10}")


def extract_bvid(stdout: str) -> str | None:
    m = _BVID_RE.search(stdout or "")
    return m.group(0) if m else None


def _cookie_header(cookie_path: Path) -> str:
    """B 站 cookie 文件 → Cookie header（v0.8.4 统一 data/core/cookies.json）。

    兼容两种格式：biliup 风格 {"cookies": {...}} / 直接 dict，以及
    B 站 passport 登录响应 cookie_info.cookies 数组（biliup-cli 存储格式）。
    """
    try:
        data = json.loads(cookie_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    if not isinstance(data, dict):
        return ""
    cookies: dict = {}
    raw = data.get("cookies")
    if isinstance(raw, dict):
        cookies = raw
    elif isinstance(raw, list):
        cookies = {c.get("name"): c.get("value") for c in raw if isinstance(c, dict) and c.get("name")}  # noqa: E501
    else:
        info = data.get("cookie_info")
        if isinstance(info, dict) and isinstance(info.get("cookies"), list):
            cookies = {
                c.get("name"): c.get("value")
                for c in info["cookies"]
                if isinstance(c, dict) and c.get("name")
            }
    return "; ".join(f"{k}={v}" for k, v in cookies.items() if v is not None and k)


async def fetch_bvid_stats(bvid: str) -> dict | None:
    """按 BV 号拉取统计；失败返回 None（静默）。"""
    try:
        cookie_path = Path(settings.data_dir) / "core" / "cookies.json"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
            )
        }
        cookie = _cookie_header(cookie_path)
        if cookie:
            headers["Cookie"] = cookie
        async with httpx.AsyncClient(
            headers=headers, timeout=20, follow_redirects=True
        ) as client:
            resp = await client.get(
                "https://api.bilibili.com/x/web-interface/view",
                params={"bvid": bvid},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        if body.get("code") != 0:
            return None
        stat = (body.get("data") or {}).get("stat") or {}
        picked = {k: int(stat.get(k) or 0) for k in _STAT_KEYS}
        if picked.get("view", 0) <= 0:
            return None  # 数据未就绪/稿件未过审——下次再拉
        return picked
    except Exception:  # noqa: BLE001 — 回捞失败静默，调度器不炸
        logger.warning("bvid stats fetch failed for %s (best effort)", bvid)
        return None


def stats_expired(publish_json: dict | None, max_age_hours: float = 12.0) -> bool:
    """stats 缺失或超过 max_age 才值得重新拉取。"""
    if not publish_json or not publish_json.get("bvid"):
        return False
    if not publish_json.get("stats"):
        return True
    raw = publish_json.get("stats_at")
    if not raw:
        return True
    try:
        at = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        return (datetime.now(UTC) - at).total_seconds() > max_age_hours * 3600
    except ValueError:
        return True
