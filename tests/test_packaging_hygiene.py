"""依赖声明与打包配置的卫生守卫（v0.31 B1 / D-200）。

存在理由：faster-whisper 曾长期住在 `[project.optional-dependencies].asr` 里，
而 `ctranslate2` 连声明都没有（只是 faster-whisper 的传递依赖）。CI、`scripts/dev.sh`
与发布模拟脚本一律跑裸 `uv sync`，于是「零 API 的转写与翻译」在开发态和打包态
**同时**不可用，且没有任何自动检查能发现这件事（v0.31 spike 才暴露）。
"""

from __future__ import annotations

import ast
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"


def _dep_names(raw: str) -> set[str]:
    data = tomllib.loads(raw)
    return {
        re.split(r"[<>=!~;\[\s]", str(d))[0].strip().lower()
        for d in data["project"].get("dependencies", [])
    }


def test_local_engine_runtimes_are_main_dependencies() -> None:
    """被代码直接 import 的运行时必须是主依赖，不能靠可选组或传递依赖活着。"""
    names = _dep_names((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    for pkg in ("faster-whisper", "ctranslate2", "sentencepiece"):
        assert pkg in names, f"{pkg} 不在主依赖里——本地引擎会静默不可用"


def test_asr_optional_group_stays_retired() -> None:
    """`asr` 可选组一旦复活，裸 uv sync 的环境又会悄悄失去转写能力。"""
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert "asr" not in data["project"].get("optional-dependencies", {})


def test_no_stale_extra_asr_instructions() -> None:
    """代码里不得再出现 `uv sync --extra asr`——对 dmg 用户无意义且已失效。"""
    offenders = [
        str(p.relative_to(ROOT))
        for p in sorted(BACKEND.rglob("*.py"))
        if "--extra asr" in p.read_text(encoding="utf-8")
    ]
    assert not offenders, "仍在指导用户安装可选组: " + ", ".join(offenders)


def test_local_engine_not_blocked_from_bundle() -> None:
    """hertz.spec 不得再把本地引擎放进 excludes。

    `faster_whisper` 曾长期列在 blocklist 里——它让「转写随包可用」这件事在
    源码、文档、测试三处都成立，只有产物里没有，且任何测试都碰不到。"""
    spec = (ROOT / "hertz.spec").read_text(encoding="utf-8")
    m = re.search(r"^blocklist\s*=\s*\[(.*?)\]", spec, re.M | re.S)
    assert m, "读不到 blocklist 定义"
    blocked = {s.strip().strip("\"'") for s in m.group(1).split(",") if s.strip()}
    for pkg in ("faster_whisper", "ctranslate2", "av", "onnxruntime"):
        assert pkg not in blocked, f"{pkg} 又被排除出固化包——打包版将静默失去该能力"


def test_frozen_entrypoint_declares_freeze_support() -> None:
    """冻结入口必须先 freeze_support()。

    v0.31 spike 实测：缺它时每次构造 WhisperModel 都会让冻结体自我重跑
    （45 秒内进程 1→7，累积观测到 138 个残留）——第一次转写就拖死用户机器，
    而非冻结的开发态完全看不出问题。"""
    src = (ROOT / "backend" / "entrypoint.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    main_fn = next(
        n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main"
    )
    calls = [
        n for n in ast.walk(main_fn)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Attribute)
        and n.func.attr == "freeze_support"
    ]
    assert calls, "entrypoint.main() 缺 multiprocessing.freeze_support()"
    # 必须在使用任何子进程之前——即排在数据库/迁移调用之前
    first_call_line = min(c.lineno for c in calls)
    migrate_calls = [
        n.lineno for n in ast.walk(main_fn)
        if isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id in {"_ensure_database", "_migrate"}
    ]
    assert migrate_calls, "找不到启动步骤，守卫假设已变"
    assert first_call_line < min(migrate_calls), "freeze_support 必须最先执行"
