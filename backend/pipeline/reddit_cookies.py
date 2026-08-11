"""Reddit Cookie 方案（v0.8.1，参考原项目 Autarkeia reddit_auth.py）。

背景：Reddit OAuth 个人应用申请困难（用户实证）——改用浏览器登录 Cookie：
- 字符串直填（设置页）或 Netscape 文件（data/reddit_cookies.txt）
- 文件缺失/过期时用 yt-dlp `--cookies-from-browser` 自动导出（chrome/safari/edge…）
- 下载/采集请求带 Cookie header，CDN 不再 403

安全（参考原项目）：
- Cookie 内容永不进日志 / API 响应（只报存在性/年龄/来源）
- 导出最多每 N 小时一次，失败软降级（不影响匿名链路）
"""

import json
import logging
import os
import subprocess
import time
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

_BROWSER_CANDIDATES = ("chrome", "safari", "edge", "chromium", "firefox")
_export_lock_until = 0.0
_EXPORT_MIN_INTERVAL = 3600.0  # 两次自动导出最小间隔（1 小时）


def cookies_file_path() -> Path:
    """Netscape cookie 文件路径（单一真相源）。"""
    return Path(settings.data_dir) / "reddit_cookies.txt"


def cookies_status() -> dict:
    """健康状态（供设置页）：只报存在性/年龄/浏览器，绝不返回 cookie 内容。"""
    path = cookies_file_path()
    exists = path.exists() and path.stat().st_size >= 40
    age_s = int(time.time() - path.stat().st_mtime) if exists else None
    return {
        "exists": exists,
        "age_s": age_s,
        "path": str(path),
        "cookie_set": bool((settings.pipeline_reddit_cookie or "").strip()),
    }


def _netscape_cookie_header(path: Path) -> str | None:
    """Netscape cookies.txt → Cookie header（仅 reddit 域，按名去重）。"""
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return None
    merged: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _flag, _path, _secure, _expiry, name, value = parts[:7]
        d = domain.lstrip(".").lower()
        if "reddit.com" not in d and "redd.it" not in d:
            continue
        if not name or name.startswith("#"):
            continue
        merged[name] = value
    if not merged:
        return None
    return "; ".join(f"{k}={v}" for k, v in merged.items())


def cookie_header_for_http() -> str | None:
    """下载/采集请求的 Cookie header（永不记录返回值）。"""
    raw = (settings.pipeline_reddit_cookie or "").strip()
    if raw:
        return raw
    path = cookies_file_path()
    if path.exists() and path.stat().st_size >= 40:
        return _netscape_cookie_header(path)
    return None


async def ensure_reddit_cookies(*, force: bool = False) -> dict:
    """确保 cookie 可用：字符串直填优先；文件新鲜跳过；否则浏览器自动导出。

    导出失败软降级（返回 ok=False，调用方走匿名链路）。仅报状态不报内容。
    """
    global _export_lock_until

    if (settings.pipeline_reddit_cookie or "").strip():
        return {"ok": True, "source": "config"}

    path = cookies_file_path()
    if path.exists() and path.stat().st_size >= 40 and not force:
        age = time.time() - path.stat().st_mtime
        if age < _EXPORT_MIN_INTERVAL:
            return {"ok": True, "source": "file"}

    now = time.time()
    if now < _export_lock_until:
        return {"ok": False, "source": "locked"}
    _export_lock_until = now + 120.0

    browsers = (
        [b.strip().lower() for b in settings.pipeline_reddit_cookies_browser.split(",") if b.strip()]
        if settings.pipeline_reddit_cookies_browser
        else list(_BROWSER_CANDIDATES)
    )
    for browser in browsers:
        try:
            dest = path.with_suffix(".tmp")
            if dest.exists():
                dest.unlink(missing_ok=True)
            cmd = [
                "yt-dlp",
                "--cookies-from-browser", browser,
                "--cookies", str(dest),
                "--skip-download",
                "--quiet",
                "--no-warnings",
                "https://www.reddit.com/",
            ]
            proc = await _run_export(cmd)
            if dest.exists() and dest.stat().st_size >= 40:
                dest.replace(path)
                return {"ok": True, "source": f"browser:{browser}"}
            dest.unlink(missing_ok=True)
            logger.info("cookie export skip browser=%s rc=%s", browser, proc.returncode)
        except Exception:  # noqa: BLE001 — 单个浏览器失败继续尝试下一个
            logger.warning("cookie export failed for browser=%s", browser)
    return {"ok": False, "source": "none"}


async def _run_export(cmd: list[str]) -> subprocess.CompletedProcess:
    import asyncio

    return await asyncio.to_thread(
        subprocess.run,
        cmd,
        capture_output=True,
        text=True,
        timeout=90,
        env={**os.environ, "PYTHONWARNINGS": "ignore"},
    )
