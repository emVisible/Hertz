"""脚本工坊转写端点回归测试（v0.30.1 / D-199）。

存在理由：`POST /api/studio/transcribe` 曾在函数级 `from ...asr import
whisper_importable` 上引了一个 asr 模块里根本不存在的符号（真符号在
infrastructure/deps.py），而该 import 位于 try 之外——任何真实请求都以裸
ImportError 崩成 500，ruff/tsc/既有 351 项测试全都看不见（函数级 import
只有被调用时才执行）。这里既守这一处，也守整类缺陷。
"""

from __future__ import annotations

import ast
import importlib
from pathlib import Path

import pytest
from httpx import AsyncClient

BACKEND_ROOT = Path(__file__).resolve().parent.parent / "backend"

_WEBM_HEADER = b"\x1a\x45\xdf\xa3" + b"\x00" * 200  # 够长以越过「音频过小」的 422 门槛


def _patch_whisper(monkeypatch, available: bool) -> None:
    """打桩 asr 模块属性——端点在函数内 import，调用时才取属性，故有效。"""
    import backend.pipeline.producers.asr as asr

    monkeypatch.setattr(asr, "whisper_available", lambda: available)


def test_asr_exposes_whisper_available_predicate() -> None:
    """端点依赖的谓词必须真实存在于 asr（防再次指向幽灵符号）。"""
    import backend.pipeline.producers.asr as asr

    assert callable(asr.whisper_available)
    # 曾经的错误指向：whisper_importable 属于能力矩阵探针层（deps），不在 asr
    assert not hasattr(asr, "whisper_importable")


@pytest.mark.asyncio
async def test_transcribe_returns_502_when_engine_unavailable(
    client: AsyncClient, monkeypatch
) -> None:
    """引擎不可用 → 明确的 502，而不是裸 ImportError 崩成 500。"""
    _patch_whisper(monkeypatch, False)

    resp = await client.post(
        "/api/studio/transcribe",
        files={"file": ("draft.webm", _WEBM_HEADER, "audio/webm")},
    )
    assert resp.status_code == 502, resp.text
    detail = resp.json()["detail"]
    assert "faster-whisper" in detail
    # 文案不得只对开发态成立：dmg 用户看不到 `uv sync`，必须同时给出应用内出路
    assert "设置" in detail, f"缺少打包版指引: {detail}"


@pytest.mark.asyncio
async def test_transcribe_rejects_undersized_payload(
    client: AsyncClient, monkeypatch
) -> None:
    """守卫放行后才走到体积校验：422 而不是 500——同时反证 import 未炸。"""
    _patch_whisper(monkeypatch, True)

    resp = await client.post(
        "/api/studio/transcribe",
        files={"file": ("draft.webm", b"\x1a\x45\xdf\xa3", "audio/webm")},
    )
    assert resp.status_code == 422, resp.text


# ---------- 整类缺陷守卫 ----------

def _function_level_backend_imports(tree: ast.Module) -> list[tuple[int, str, str]]:
    """收集「函数体内、且不在 try 里」的 `from backend.x import y`。"""
    found: list[tuple[int, str, str]] = []

    class Walker(ast.NodeVisitor):
        def __init__(self) -> None:
            self.in_func = 0
            self.in_try = 0

        def visit_Try(self, node: ast.Try) -> None:  # noqa: N802
            self.in_try += 1
            self.generic_visit(node)
            self.in_try -= 1

        def visit_FunctionDef(self, node) -> None:  # noqa: N802
            self.in_func += 1
            self.generic_visit(node)
            self.in_func -= 1

        visit_AsyncFunctionDef = visit_FunctionDef  # noqa: N815

        def visit_ImportFrom(self, node: ast.ImportFrom) -> None:  # noqa: N802
            if (
                self.in_func
                and not self.in_try
                and node.module
                and node.module.startswith("backend.")
            ):
                for alias in node.names:
                    if alias.name != "*":
                        found.append((node.lineno, node.module, alias.name))
            self.generic_visit(node)

    Walker().visit(tree)
    return found


def test_no_phantom_function_level_imports() -> None:
    """全仓函数级 backend.* import 的符号必须真实存在。

    这类写法只有运行到那一行才报错，正是「ruff 绿、测试绿、线上一调就 500」
    的形状（studio.py 的 whisper_importable 即为此）。"""
    offenders: list[str] = []
    checked = 0
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:  # pragma: no cover — 门禁阶段 ruff 已先拦
            continue
        for lineno, module, name in _function_level_backend_imports(tree):
            checked += 1
            try:
                mod = importlib.import_module(module)
            except Exception as exc:  # 模块本身导不动 → 同样是缺陷
                offenders.append(f"{path}:{lineno} import {module} → {type(exc).__name__}: {exc}")
                continue
            if hasattr(mod, name):
                continue
            # 子模块形态（from backend.a import b 其中 b 是模块）
            try:
                importlib.import_module(f"{module}.{name}")
            except ImportError:
                offenders.append(f"{path}:{lineno} from {module} import {name}")

    assert checked > 50, f"扫描到 {checked} 处，守卫疑似失效（正则/遍历写坏了）"
    assert not offenders, "函数级 import 指向不存在的符号:\n  " + "\n  ".join(offenders)
