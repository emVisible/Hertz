"""依赖声明与打包配置的卫生守卫（v0.31 B1 / D-200）。

存在理由：faster-whisper 曾长期住在 `[project.optional-dependencies].asr` 里，
而 `ctranslate2` 连声明都没有（只是 faster-whisper 的传递依赖）。CI、`scripts/dev.sh`
与发布模拟脚本一律跑裸 `uv sync`，于是「零 API 的转写与翻译」在开发态和打包态
**同时**不可用，且没有任何自动检查能发现这件事（v0.31 spike 才暴露）。
"""

from __future__ import annotations

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
