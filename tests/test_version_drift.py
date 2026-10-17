"""三方版本号必须一致（2026-10-17 加）。

起因是一次真实的排查误导：`backend/config.py` 的 `APP_VERSION` 长期停在
`0.35.0`，而 `pyproject.toml` 与两个 `package.json` 已经是 `0.36.0`——查
"重启风暴是哪个版本引入的"时，日志里每行都写着 v0.35.0，人会先怀疑代码
而不是怀疑版本号本身。

版本号散在四个文件里、靠"发版时人工对齐"，那就迟早会漂。这里把它变成判据。
"""

import json
import re
from pathlib import Path

import pytest

from backend.config import APP_VERSION

ROOT = Path(__file__).resolve().parents[1]


def _pyproject_version() -> str:
    text = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    m = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
    assert m, "pyproject.toml 里找不到 version 字段"
    return m.group(1)


def _package_version(rel: str) -> str:
    return json.loads((ROOT / rel).read_text(encoding="utf-8"))["version"]


def test_app_version_matches_pyproject() -> None:
    assert APP_VERSION == _pyproject_version(), (
        f"backend APP_VERSION={APP_VERSION} 与 pyproject "
        f"{_pyproject_version()} 不一致——日志里的版本号会误导排查"
    )


@pytest.mark.parametrize("rel", ["frontend/package.json", "electron/package.json"])
def test_package_versions_match(rel: str) -> None:
    assert _package_version(rel) == APP_VERSION, f"{rel} 的 version 与后端不一致"


def test_app_version_is_not_a_placeholder() -> None:
    # 防"忘了改"退化成模板值
    assert APP_VERSION not in ("", "0.0.0", "x.y.z")
    assert re.fullmatch(r"\d+\.\d+\.\d+", APP_VERSION), APP_VERSION