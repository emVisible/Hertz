"""设置页「改了要存得下去」的仓库级护栏（v0.32 S4.1）。

存在理由：v0.20 把 SettingsPage 拆成 sections 时，`save()` 里的字段表被删成
`overrides: {}` ——此后整整十几个版本，设置页每个输入框都是装饰品：改动只活在
内存里，点保存却 toast「已保存」。tsc、vitest、pytest 与人工冒烟全都看不见，
因为它「一切正常」的形式恰好是空载荷该有的形式。

所以这里不测某个字段，测的是这条链的三个断点：
① 分区里能编辑的 key 必须在主壳有草稿（没草稿 = 保存时被丢掉）；
② 草稿 key 必须在后端白名单里（不在 = 整个 PATCH 400，全部字段一起存不下）；
③ `save()` 不得再退回字面量空对象。
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SETTINGS_DIR = ROOT / "frontend/src/pages/settings"
BACKEND_CONFIG = ROOT / "backend/routers/config.py"


def _allowlist() -> set[str]:
    tree = ast.parse(BACKEND_CONFIG.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "RUNTIME_ALLOWLIST":
                    return {
                        str(e.value)
                        for e in node.value.elts
                        if isinstance(e, ast.Constant)
                    }
    raise AssertionError("backend/routers/config.py 里找不到 RUNTIME_ALLOWLIST")


def _seed_keys() -> set[str]:
    """主壳 `setForm({...})` 里种下的草稿键。"""
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    start = src.index("setForm({")
    body = src[start:]
    end = body.index("\n    })")
    block = body[:end]
    return set(re.findall(r"^\s{6}([A-Za-z0-9_]+):", block, re.M))


def _edited_keys() -> set[str]:
    """分区里真正可编辑/可读取的键（`set('k', …)` 与 `form.k`）。"""
    out: set[str] = set()
    for path in sorted(SETTINGS_DIR.rglob("*.tsx")):
        if path.name == "SettingsPage.tsx":
            continue
        src = path.read_text(encoding="utf-8")
        out |= set(re.findall(r"set\(\s*'([A-Za-z0-9_]+)'", src))
        out |= set(re.findall(r"\bform\.([A-Za-z0-9_]+)", src))
    return out


def test_every_edited_key_has_a_draft_seed() -> None:
    seeds = _seed_keys()
    missing = sorted(_edited_keys() - seeds)
    assert not missing, (
        "这些设置项能被编辑却没进草稿，保存时会被整个丢掉（v0.20 那次的形状）: "
        + ", ".join(missing)
    )


def test_every_seed_is_runtime_writable() -> None:
    """草稿里的键必须都能写：PATCH 对未知键整体 400，一个漏白名单就全盘存不下。"""
    allow = _allowlist()
    unknown = sorted(_seed_keys() - allow)
    assert not unknown, (
        "SettingsPage 草稿含后端不接受的键，保存必然 400: " + ", ".join(unknown)
    )


def test_seed_is_not_trivially_small() -> None:
    """草稿键数量掉到 5 以下 = 主壳被掏空（v0.20 回归的直接形态）。"""
    assert len(_seed_keys()) >= 40, "设置页草稿疑似被删空——保存又是空载荷"


def test_save_sends_the_draft_diff_not_a_literal_empty_object() -> None:
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    assert not re.search(r"overrides:\s*\{\s*\}", src), (
        "save() 又回退成字面量空 overrides——设置页将只演出不落盘"
    )
    assert "buildOverrides(cfg, form)" in src, "save() 必须提交草稿与配置的差集"


def test_write_only_secret_fields_are_not_seeded_with_baseline() -> None:
    """只写不读的字段（后端滤掉）必须靠「空 = 不动」语义，不能拿 cfg 的值去种。

    反向保护：有人「顺手」把 cookie/secret 也写进 cfg 类型，等于假设后端会回吐
    明文——那是 §8.2 明令禁止的。
    """
    src = (SETTINGS_DIR / "SettingsPage.tsx").read_text(encoding="utf-8")
    for key in ("pipeline_reddit_cookie", "pipeline_reddit_client_secret"):
        assert re.search(rf"{key}: ''", src), (
            f"{key} 必须以空串为草稿（后端只写不读），不能从 cfg 取值"
        )


@pytest.mark.parametrize(
    "key", ["pipeline_hf_endpoint", "pipeline_whisper_model"]
)
def test_v032_model_settings_are_wired_end_to_end(key: str) -> None:
    """S4 新加的两项设置：后端有字段、白名单收得下、前端有种有编辑。"""
    assert key in _allowlist()
    assert key in _seed_keys()
    assert key in _edited_keys()
    assert key in (ROOT / "backend/config.py").read_text(encoding="utf-8")
