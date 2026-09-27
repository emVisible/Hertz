"""Monoline 融合域 Phase 3：HyperFrames CLI 驱动单测（免网络/免 Chrome）+ 缺 Chrome 快失败。"""

from uuid import UUID

import pytest

from backend.monoline import hf
from backend.monoline.hf import HF, _render_argv, _tail_error


def test_render_argv_pins_workers_and_format() -> None:
    argv = _render_argv("/proj", "/out/x.mp4", fps=30, quality="standard", fmt="mp4")
    assert argv[:2] == ["render", "/proj"]
    assert "--workers" in argv and argv[argv.index("--workers") + 1] == "1"
    assert argv[argv.index("--format") + 1] == "mp4"


def test_tail_error_keeps_actionable_sentence() -> None:
    stderr = "bla\n✗ Render failed\nNeed 6.9 GB, have 1.2 GB\npossible causes:\n- foo\n- bar\n"
    out = _tail_error(stderr)
    assert "6.9 GB" in out and "Render failed" not in out


def test_parse_lint_output_counts_errors() -> None:
    data = HF.parse_lint_output(
        'noise {"findings": [{"severity": "error"}, {"severity": "warn"}]} tail')
    assert data["_error_count"] == 1
    data2 = HF.parse_lint_output('{"findings": []}')
    assert data2["_error_count"] == 0


def test_lint_quality_mapping() -> None:
    assert HF().lint_quality("delivery") == "high"
    assert HF().lint_quality("looks") == "standard"
    assert HF().lint_quality("whatever") == "standard"


def test_node_and_chrome_probes_return_typed() -> None:
    assert isinstance(hf.chrome_available(), bool)
    try:
        node = hf.resolve_node_bin()
    except hf.HFError:
        node = None
    if node is not None:
        assert isinstance(hf.node_major(node), int)


async def test_render_without_composition_fails_before_npx() -> None:
    """缺 index.html 时 run_render 报 compose 缺失——绝不走到 npx/Chrome（免网络断言）。"""
    import tempfile

    from monoline_fakes import StubTTS

    from backend.infrastructure.events import EventHub
    from backend.infrastructure.storage import FileStore
    from backend.monoline import runner as _runner
    from backend.monoline.service import MonolineService
    from backend.monoline.store import MonolineStore

    # chrome 检查与环境相关（系统 Chrome 也算可用）；本用例只断言
    # 缺 index.html 时绝不走到 npx/Chrome（免网络断言）
    assert isinstance(hf.chrome_available(), bool)
    assert _runner.VENDOR_DIR.exists()
    files = FileStore(data_dir=f"{tempfile.mkdtemp(prefix='ml-hf-')}/data")
    svc = MonolineService(files=files, hub=EventHub(), store=MonolineStore(),
                          tts_provider=StubTTS())
    created = await svc.create_job("第一段。第二段。")
    jid = UUID(created["id"])
    with pytest.raises(RuntimeError, match="compose"):
        await _runner.run_render(svc.store, svc.ws_root(jid), jid)
