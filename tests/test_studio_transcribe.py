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
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

BACKEND_ROOT = Path(__file__).resolve().parent.parent / "backend"

_WEBM_HEADER = b"\x1a\x45\xdf\xa3" + b"\x00" * 200  # 够长以越过「音频过小」的 422 门槛

# v0.31 spike 在打包版上实测到的原始输出（含繁体与错字，见 D-200）
REAL_TRADITIONAL_SAMPLE = "今天天氣不錯,我打算去公園離走走,順便錄一段雨嬰草稿事實"


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


@pytest.mark.asyncio
async def test_model_unavailable_maps_to_502_by_type(client, monkeypatch) -> None:
    """模型未就绪/下载失败 → 502。

    实测回归（v0.32 S4 产物级）：端点原先靠 `"faster-whisper" in str(exc)` 判 502，
    S4 把文案换成「whisper 模型未就绪且下载失败」后当场退成裸 500——外部条件不可用
    与内部异常必须按**类型**分，不能按话说得像不像来分。
    """
    import backend.pipeline.producers.asr as asr

    _patch_whisper(monkeypatch, True)

    async def boom(*_a, **_k):
        raise asr.AsrUnavailableError(
            "whisper 模型未就绪且下载失败（base）——设置 → 流水线 可切换下载端点后重试"
        )

    monkeypatch.setattr(asr, "transcribe_cues", boom)
    resp = await client.post(
        "/api/studio/transcribe",
        files={"file": ("draft.webm", _WEBM_HEADER, "audio/webm")},
    )
    assert resp.status_code == 502, resp.text
    assert "设置" in resp.json()["detail"]  # 必须给出应用内出路


@pytest.mark.asyncio
async def test_unexpected_error_still_500_not_masked_as_502(client, monkeypatch) -> None:
    """反向对照：真正的内部异常不许被顺手报成「引擎不可用」。"""
    import backend.pipeline.producers.asr as asr

    _patch_whisper(monkeypatch, True)

    async def boom(*_a, **_k):
        raise ValueError("faster-whisper 里某个参数不对")  # 文案含关键词，旧实现会误判 502

    monkeypatch.setattr(asr, "transcribe_cues", boom)
    resp = await client.post(
        "/api/studio/transcribe",
        files={"file": ("draft.webm", _WEBM_HEADER, "audio/webm")},
    )
    assert resp.status_code == 500, resp.text


def test_no_second_whisper_transcribe_call_site() -> None:
    """whisper 的 `model.transcribe(` 只允许出现在 asr.py 一处。

    实测缺陷（v0.32 S3）：工坊在 studio.py 里自己调了一次 `model.transcribe`，
    于是 asr.transcribe_with_whisper 的「自动检测出繁体 → 带简体 prompt 重转」
    只作用于字幕产线，工坊中文实测输出繁体（今天天氣不錯…公園離走走）。
    两条调用链共享一个语义时，必须只有一个权威实现。"""
    offenders = []
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        if path.name == "asr.py":
            continue
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            code = line.strip()
            if code.startswith("#"):
                continue
            if "model.transcribe(" in code or "_get_whisper" in code:
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{i}")
    assert not offenders, (
        "出现第二处 whisper 直调（应复用 asr.transcribe_cues）: " + ", ".join(offenders)
    )


def test_cues_mapper_is_single_source_of_truth() -> None:
    """工坊与字幕产线的 cue 结构必须共用 asr 的出口，不得各自组装一遍。"""
    import backend.pipeline.producers.asr as asr

    assert hasattr(asr, "transcribe_cues"), "缺少共享转写出口 transcribe_cues"
    studio_src = (BACKEND_ROOT / "routers" / "studio.py").read_text(encoding="utf-8")
    assert "transcribe_cues" in studio_src, "工坊未走共享出口"


class _FakeWord:
    def __init__(self, word: str, start: float, end: float) -> None:
        self.word, self.start, self.end = word, start, end


class _FakeSeg:
    def __init__(self, words) -> None:
        self.words = words


class _FakeModel:
    """第一次返回繁体，第二次（带简体 prompt）返回简体——复现 base 模型的真实行为。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def transcribe(self, _path, **kw):
        self.calls.append(kw)
        traditional = len(self.calls) == 1
        text = "今天天氣不錯" if traditional else "今天天气不错"
        words = [_FakeWord(ch, i * 0.4, i * 0.4 + 0.35) for i, ch in enumerate(text)]
        return [_FakeSeg(words)], SimpleNamespace(language="zh")


@pytest.mark.asyncio
async def test_workshop_output_is_simplified(client: AsyncClient, monkeypatch) -> None:
    """工坊中文产出不含繁体字——S3 的正题（行为级，不测实现）。"""
    from backend.pipeline.producers import asr
    from backend.pipeline.producers.asr import _has_traditional

    fake = _FakeModel()

    async def _fake_get_whisper():
        return fake

    monkeypatch.setattr(asr, "_get_whisper", _fake_get_whisper)
    monkeypatch.setattr(asr, "whisper_available", lambda: True)

    resp = await client.post(
        "/api/studio/transcribe",
        files={"file": ("draft.wav", _WEBM_HEADER, "audio/wav")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["text"], "转写文本为空"
    assert not _has_traditional(body["text"]), f"工坊输出繁体: {body['text']}"
    # 纠偏必须是真发生的第二次调用，而不是字符串转换糊过去
    assert len(fake.calls) == 2, f"未触发简体重转，调用记录: {fake.calls}"
    assert fake.calls[1].get("initial_prompt"), "重转未带简体 initial_prompt"


def test_traditional_detector_covers_real_model_output() -> None:
    """检测集必须覆盖 base 模型的**真实**繁体输出。

    v0.32 S3 实测：打包版转出「今天天氣不錯…公園…錄…雨嬰草稿事實」，
    而原 63 字检测集不含 氣/錯/園/錄/順/實/語/嬰 → `_has_traditional` 返回
    False，简体重转纠偏根本不触发（字幕产线与工坊同时受影响）。"""
    from backend.pipeline.producers.asr import _TRADITIONAL_CHARS, _has_traditional

    assert _has_traditional(REAL_TRADITIONAL_SAMPLE), "实测繁体句未被识别——纠偏永不触发"
    for ch in "氣錯園錄順實語嬰":
        assert ch in _TRADITIONAL_CHARS, f"{ch} 缺失"


def test_traditional_detector_excludes_simplified_forms() -> None:
    """简体字形绝不能在集合里。

    这些字与上面的繁体字互为简繁（气↔氣 / 错↔錯 / 录↔錄 …）。混进集合会让
    正常简体文本误触发一次额外的 whisper 重转——白烧 CPU 且拖慢工坊响应。"""
    from backend.pipeline.producers.asr import _TRADITIONAL_CHARS

    for ch in "气错园录顺实语婴图块坛画众尽据处虑头题脚脸":
        assert ch not in _TRADITIONAL_CHARS, f"简体字 {ch} 混入检测集会造成误触发"


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
