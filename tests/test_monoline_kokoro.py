"""Monoline 融合域：真 Kokoro 链路集成测试（需 data/models/kokoro 权重，缺失则跳过）。

conftest 把 HERTZ_DATA_DIR 指向临时目录，此处把 tts_zh 的路径函数 monkeypatch
回真实权重位置，验证 provider→ONNX→wav 全链。
"""

from pathlib import Path

import pytest

from backend.ai.providers.kokoro import KokoroProvider
from backend.monoline import tts_zh

REPO = Path(__file__).resolve().parent.parent
WEIGHTS = ("data/models/kokoro/models/kokoro-v1.0.onnx",
           "data/models/kokoro/voices/voices-v1.0.bin")
MODEL = REPO / WEIGHTS[0]
VOICES_P = REPO / WEIGHTS[1]

needs_weights = pytest.mark.skipif(
    not (MODEL.exists() and VOICES_P.exists()),
    reason="Kokoro weights not in data/models/kokoro",
)


@pytest.fixture()
def real_weights(monkeypatch):
    # conftest 把 DATA_DIR 指到临时目录：把路径函数指回仓库真实权重
    monkeypatch.setattr(tts_zh, "_model_path", lambda: MODEL)
    monkeypatch.setattr(tts_zh, "_voices_path", lambda: VOICES_P)
    tts_zh._engine.clear()


@needs_weights
async def test_kokoro_synthesize_real(real_weights) -> None:
    wav = await KokoroProvider().synthesize("你好，世界。", "zf_xiaoxiao")
    assert wav[:4] == b"RIFF" and len(wav) > 10000


@needs_weights
async def test_kokoro_unknown_voice_falls_back(real_weights) -> None:
    wav = await KokoroProvider().synthesize("测试", "no-such-voice")
    assert wav[:4] == b"RIFF"


@needs_weights
async def test_kokoro_applies_clean_and_rate(real_weights) -> None:
    # A0：数字行可合成（rate 降速不断言时长，只断言产出）；无可说内容抛错
    wav = await KokoroProvider().synthesize("2026年有365天。", "zf_xiaoxiao")
    assert wav[:4] == b"RIFF"
    with pytest.raises(ValueError):
        await KokoroProvider().synthesize("   ", "zf_xiaoxiao")


def test_kokoro_voices_list() -> None:
    assert len(KokoroProvider.voices()) == 25
