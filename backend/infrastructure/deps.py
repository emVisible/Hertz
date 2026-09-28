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
    source = "system"
    if not path:
        # v0.21 安装即用：系统缺失时回退 imageio-ffmpeg 自带二进制
        #（固化包内置；7.1 构建实测含 libass，字幕烧录可用）
        try:
            import imageio_ffmpeg

            path = str(imageio_ffmpeg.get_ffmpeg_exe())
            source = "bundled"
        except Exception:  # noqa: BLE001 — 未安装/二进制缺失按 missing 处理
            path = None
    if not path:
        return {
            "status": "missing",
            "path": None,
            "source": None,
            "version": None,
            "libass": False,
            # v0.8.9：官方 brew ffmpeg 8.x 已移除 libass——安装指引指向社区完整版 tap
            "install_hint": "brew install homebrew-ffmpeg/ffmpeg/ffmpeg",
        }
    libass = await _ffmpeg_has_filter(path, "subtitles")
    result: dict = {
        "status": "ok",
        "path": path,
        "source": source,
        "version": await _ffmpeg_version(path),
        "libass": libass,
    }
    if not libass:
        result["install_hint"] = (
            "brew install homebrew-ffmpeg/ffmpeg/ffmpeg"
            "（官方 brew 8.x 版无 libass，字幕烧录需此完整版）"
        )
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


async def _check_local_mt() -> dict:  # noqa: C901 — 依赖/模型两级判定，拆开会绕
    """本地翻译引擎（v0.22.x）：sentencepiece/ctranslate2 依赖 + ct2 模型文件。

    路径与文件清单的权威在 `infrastructure/paths.py`（此前这里与
    `translate_engine.model_dir()` 各写一份字符串，属于双真相源）。
    """
    for mod in ("sentencepiece", "ctranslate2"):
        try:
            importlib.util.find_spec(mod)
        except (ImportError, ValueError):
            return {
                "status": "missing",
                "install_hint": "重新运行 uv sync（sentencepiece 已随主依赖安装）",
            }
    from backend.infrastructure import paths

    d = paths.local_mt_dir()
    if not paths.local_mt_ready():
        missing = [f for f in paths.LOCAL_MT_CORE_FILES if not (d / f).exists()]
        return {
            "status": "missing",
            "detail": f"模型未下载: {', '.join(missing)}",
            "install_hint": "设置 → 流水线 → 「下载本地翻译模型」",
        }
    return {"status": "ok", "path": str(d)}


def _check_whisper_model() -> dict:  # noqa: C901 — 状态分支表，拆开反而绕
    """whisper 本地模型就绪态：xinference 服务 / 应用内模型目录 / 待下载。

    v0.32 S4：探测目录从 `~/.cache/huggingface` 改到 `data_dir/models/whisper`
    ——HF 默认缓存落在应用沙箱之外，打包版「下了模型也探不到」，
    且 `HERTZ_DATA_DIR` 隔离形同被绕过（`HERTZ_USER_DATA` 的存在理由就是不碰 $HOME）。
    """
    xinference_on = bool(str(getattr(settings, "xinference_stt_model_id", "") or "").strip())

    if not whisper_importable():
        return {
            "status": "missing",
            "install_hint": "执行 uv sync；打包版缺此依赖说明用的是 v0.31 前的安装包",
        }
    if xinference_on:
        return {"status": "ok", "source": "xinference"}

    from backend.infrastructure import paths

    name = str(getattr(settings, "pipeline_whisper_model", "") or "base").strip() or "base"
    info: dict = {"model_name": name, "dir": str(paths.whisper_model_dir(name))}
    if paths.whisper_model_ready(name):
        return {"status": "ok", "source": "app-data", **info}
    # 依赖已装但模型未下载——可一键下载，或首次转写时自动下载（非阻断）
    return {
        "status": "pending",
        **info,
        "detail": f"模型未下载（档位 {name}）——设置 → 流水线 可一键下载",
    }


def whisper_importable() -> bool:
    try:
        importlib.util.find_spec("faster_whisper")
        return True
    except (ImportError, ValueError):
        return False


async def _check_llm_registry() -> dict:
    """LLM chat 可用性（评分/脚本/标题/翻译的公共底座）。"""
    from backend.ai.registry import ProviderRegistry

    resolved = await ProviderRegistry().resolve_role("main")
    if resolved is None:
        return {
            "status": "missing",
            "install_hint": "设置 → AI → 添加对话 Provider",
        }
    return {"status": "ok", "model": resolved.get("model_key", "")}


def _check_telegram_cfg() -> dict:
    from backend.config import settings as app_settings

    if not getattr(app_settings, "telegram_enabled", False):
        return {"status": "off"}
    token = str(getattr(app_settings, "telegram_bot_token", "") or "").strip()
    chat_id = str(getattr(app_settings, "telegram_chat_id", "") or "").strip()
    if token and chat_id:
        return {"status": "ok"}
    return {
        "status": "error",
        "detail": "已启用但 token/chat_id 不完整",
        "install_hint": "设置 → Telegram 补全配置",
    }


def reddit_credentials_configured() -> bool:
    """Reddit OAuth 凭证齐不齐——**这条判据的唯一作者**。

    id 与 secret 必须都非空才谈得上签名直链（只填一半，OAuth 换 token 会 401）。
    能力矩阵条目与 `GET /api/pipeline/reddit-auth/status` 都读这里：判据在第二处
    重写就会漂移成「矩阵说 ok、端点说没配」。
    """
    return bool(
        str(getattr(settings, "pipeline_reddit_client_id", "") or "").strip()
        and str(getattr(settings, "pipeline_reddit_client_secret", "") or "").strip()
    )


def _check_reddit_auth() -> dict:
    """Reddit OAuth 凭证（决定 v.redd.it 被 403 时能否走签名直链）。

    为什么单列一条：`ensure_reddit_token()` 未配置时直接返回 None，签名直链兜底
    「从未生效」这件事在界面上完全不可见——用户体感只是「下载偶尔失败」，
    正是 D-190 要消灭的静默形状。它是可选能力（匿名通道可用），故只报不阻断。
    """
    if reddit_credentials_configured():
        return {"status": "ok", "detail": "签名直链兜底已启用"}
    return {
        "status": "off",
        "detail": "未配置凭证：v.redd.it 被 CDN 403 时无签名直链可用",
        "install_hint": "设置 → 流水线 → Reddit 采集（建 script 应用后填 client id/secret）",
    }



# ── 新增可选能力四件套（D-190 约定，防静默降级复发）──────────────
# 1. pyproject 可选依赖组或主依赖（轻量核心能力直接进主依赖）
# 2. 本文件注册检查条目（结构 {status, detail?, install_hint?}，
#    status ∈ ok / missing / pending / off / error）
# 3. preflight.plan_capability_checks 映射生产方式 → 阻断/警告
#    （仅制作期能力；plan_capability_checks 的入参是 produce 开关，
#     采集/下载期能力如 telegram、reddit_auth 无处可映射=不阻断，只报）
# 4. DepsCard LABELS 加显示名
# 缺任何一件 = 下一个「制作到一半才发现」事故。
# ──────────────────────────────────────────────────────────────


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
        # v0.22.x 能力矩阵扩展：可选能力使用前可见（D-190）
        "local_mt": await _check_local_mt(),
        "whisper_model": _check_whisper_model(),
        "llm": await _check_llm_registry(),
        "telegram": _check_telegram_cfg(),
        "reddit_auth": _check_reddit_auth(),
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


_baseline_seen = False  # 启动预热只建基线，不告警（v0.22.x L3 变化即知）
_last_degrade_sig: str | None = None  # 告警去重：同退化组合不重复推


def _diff_degradation(prev: dict | None, curr: dict) -> list[str]:
    """能力退化 diff（纯函数）：ok → 非 ok 的条目列表（供告警）。"""
    out: list[str] = []
    if not prev:
        return out
    for key, cur in curr.items():
        if key in ("checked_at",):
            continue
        was_ok = isinstance(prev.get(key), dict) and prev[key].get("status") == "ok"
        now_bad = isinstance(cur, dict) and cur.get("status") != "ok"
        if was_ok and now_bad:
            detail = str(cur.get("detail") or cur.get("install_hint") or "")[:80]
            out.append(f"{key}（{cur.get('status')}{'：' + detail if detail else ''}）")
    return out


async def refresh_dependencies() -> dict:
    """重新检测并持久化（启动预热 / 设置页手动触发）。

    v0.22.x L3 变化即知：与上次快照比对，出现能力退化（ok→missing/error）
    时 Telegram 告警一次；启动首跑仅建基线。
    """
    global _baseline_seen, _last_degrade_sig, _cache
    prev = _cache
    data = await check_dependencies()

    degraded = _diff_degradation(prev, data)
    if _baseline_seen and degraded:
        sig = "|".join(degraded)
        if _last_degrade_sig != sig:
            _last_degrade_sig = sig
            try:
                from backend.integrations.telegram_bot import push_alert

                asyncio.ensure_future(push_alert(
                    "🟠 环境能力退化：" + "；".join(degraded)
                ))
            except Exception:  # noqa: BLE001 — 告警失败不影响检测
                pass
    elif not degraded:
        _last_degrade_sig = None
    _baseline_seen = True
    path = _deps_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        logger.warning("deps state persist failed (best effort): %s", path)
    _cache = data
    return data


def dep_ok(deps: dict | None, name: str) -> bool:
    """消费点统一读取（单一真相源）：status == "ok"。"""
    return bool(((deps or {}).get(name) or {}).get("status") == "ok")
