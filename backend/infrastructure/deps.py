"""基础依赖检测与状态缓存（v0.8.8）。

用户诉求：基础性基础设施/必要依赖在**初次运行时**检测一次，后续在设置页
**手动**触发重新检测——运行时不再每次探测。

此前的高频检测点（已改造为读本缓存）：
- publish_status 每 15s `shutil.which("biliup")`
- compose_video 每次后端重启后首次制作 subprocess 探测 libass
- /api/health 每次请求全量 which + import 探测

持久化：data/state/deps.json（原子写，AXIOM §17.11——tmp + replace）。
触发点：①应用启动（main.lifespan 预热一次）②设置页「重新检测」按钮
（POST /api/deps/check）。缓存存在即用，无自动重测。
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path

from backend.config import settings

logger = logging.getLogger(__name__)

# 进程内缓存（跨请求共享；文件是跨重启的持久层）
_cache: dict | None = None


def _deps_path() -> Path:
    return Path(settings.data_dir) / "state" / "deps.json"


async def _ffmpeg_version(path: str) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            str(path), "-version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        first = (out.decode(errors="replace").splitlines() or [""])[0]
        return first.strip()[:80] or "unknown"
    except Exception:  # noqa: BLE001 — 版本信息 best-effort
        return "unknown"


async def _ffmpeg_has_filter(path: str, name: str) -> bool:
    """-filters 行级精确匹配（filter 名在第二列）。"""
    try:
        proc = await asyncio.create_subprocess_exec(
            str(path), "-filters",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        return any(
            len(parts) >= 2 and parts[1] == name
            for line in out.decode(errors="replace").splitlines()
            if (parts := line.split())
        )
    except Exception:  # noqa: BLE001 — 探测失败按不支持处理（烧录降级）
        return False


async def _check_ffmpeg() -> dict:
    path = shutil.which("ffmpeg")
    if not path:
        return {
            "status": "missing",
            "path": None,
            "version": None,
            "libass": False,
            # v0.8.9：官方 brew ffmpeg 8.x 已移除 libass——安装指引指向社区完整版 tap
            "install_hint": "brew install homebrew-ffmpeg/ffmpeg/ffmpeg",
        }
    libass = await _ffmpeg_has_filter(path, "subtitles")
    result: dict = {
        "status": "ok",
        "path": path,
        "version": await _ffmpeg_version(path),
        "libass": libass,
    }
    if not libass:
        result["install_hint"] = "brew install homebrew-ffmpeg/ffmpeg/ffmpeg（官方 brew 版无 libass，字幕烧录需此完整版）"  # noqa: E501
    return result


async def _check_bin(name: str, install_hint: str) -> dict:
    path = shutil.which(name)
    return {
        "status": "ok" if path else "missing",
        "path": path,
        **({"install_hint": install_hint} if not path else {}),
    }


def _check_module(name: str, install_hint: str) -> dict:
    try:
        spec = importlib.util.find_spec(name)
    except (ImportError, ValueError):
        spec = None
    return {
        "status": "ok" if spec else "missing",
        "path": spec.origin if spec else None,
        **({"install_hint": install_hint} if spec is None else {}),
    }


async def check_dependencies() -> dict:
    """全量检测（仅启动/手动触发时执行——运行时不再调用）。

    每项携带 install_hint（缺失/降级时的安装指引）——设置页直接展示，
    单一真相源在后端（§22.2 用户语言化：安装命令随检测逻辑维护）。
    """
    return {
        "checked_at": datetime.now(UTC).isoformat(),
        "ffmpeg": await _check_ffmpeg(),
        "ffprobe": await _check_bin("ffprobe", "brew install ffmpeg"),
        "biliup": await _check_bin("biliup", "brew install biliup"),
        "yt-dlp": _check_module(
            "yt_dlp",
            "uv pip install yt-dlp  （或 brew install yt-dlp）",
        ),
        "edge-tts": _check_module(
            "edge_tts",
            "uv pip install edge-tts",
        ),
        "font": _check_subtitle_font(),
    }


def _subtitle_font_paths() -> list[Path]:
    """字幕字体候选（v0.11.2）：assets 优先，系统字体目录兜底（fontconfig/libass 可识别）。"""
    from backend.config import settings

    candidates: list[Path] = []
    for name in ("LXGWWenKai-Regular.ttf",):
        candidates.append(Path(settings.data_dir) / "assets" / "fonts" / name)
    for home in (Path.home() / "Library" / "Fonts", Path.home() / ".fonts"):
        candidates.append(home / "LXGWWenKai-Regular.ttf")
    return candidates


def _check_subtitle_font() -> dict:
    """霞鹜文楷（免费商用 OFL）探测：找到即 ASS/PNG 烧录可用的优雅中文字体。"""
    for path in _subtitle_font_paths():
        if path.exists():
            return {
                "status": "ok",
                "path": str(path),
                "family": "LXGW WenKai",
            }
    return {
        "status": "missing",
        "path": None,
        "family": "Noto Sans CJK SC",
        "install_hint": (
            "下载霞鹜文楷（OFL 免费商用）到 data/assets/fonts/: "
            "https://github.com/lxgw/LxgwWenKai/releases"
        ),
    }


def font_file() -> Path | None:
    """当前可用的字幕字体文件（无则 None，调用方回退系统字体）。"""
    for path in _subtitle_font_paths():
        if path.exists():
            return path
    return None


def load_dependencies() -> dict | None:
    """读缓存（不检测）。文件缺失/损坏 → None（调用方决定重测）。"""
    global _cache
    if _cache is not None:
        return _cache
    try:
        data = json.loads(_deps_path().read_text(encoding="utf-8"))
        _cache = data if isinstance(data, dict) else None
        return _cache
    except (OSError, ValueError):
        return None


async def refresh_dependencies() -> dict:
    """重新检测并持久化（启动预热 / 设置页手动触发）。"""
    data = await check_dependencies()
    path = _deps_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        logger.warning("deps state persist failed (best effort): %s", path)
    global _cache
    _cache = data
    return data


def dep_ok(deps: dict | None, name: str) -> bool:
    """消费点统一读取（单一真相源）：status == "ok"。"""
    return bool(((deps or {}).get(name) or {}).get("status") == "ok")
