"""v0.22.x 翻译引擎与缓存测试：local 分支 / api 回落 / 缓存命中与失效。"""

import pytest

from backend.pipeline.producers.media import (
    _localize_text,
    _subtitle_cache_hit,
)


class _Ctx:
    settings = object()

    def log(self, message: str, level: str = "info") -> None:
        pass


class _RecordingAI:
    """记录 chat 调用次数——api 路径才会触发。"""

    def __init__(self) -> None:
        self.calls = 0

    async def chat_messages(self, messages, **kwargs):
        self.calls += 1
        return "这是API翻译的译文"


def _set_engine(value: str, monkeypatch) -> None:
    from backend.config import settings as app_settings

    monkeypatch.setattr(app_settings, "pipeline_translate_engine", value, raising=False)


# ---------- 引擎分支 ----------


@pytest.mark.asyncio
async def test_local_engine_uses_mt_and_skips_llm(monkeypatch) -> None:
    _set_engine("local", monkeypatch)
    ai = _RecordingAI()

    async def fake_translate(text: str) -> str:
        return "The lamp downstairs stays on late."

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", fake_translate
    )
    out = await _localize_text(
        ai, "Hello world, this is a test.", "zh-CN", source_lang="en-US",
    )
    assert isinstance(out, str) and out  # 经清洗链返回非空
    assert ai.calls == 0, "local 引擎不应产生 LLM 调用"
    _set_engine("api", monkeypatch)


@pytest.mark.asyncio
async def test_local_engine_failure_falls_back_to_api(monkeypatch) -> None:
    _set_engine("local", monkeypatch)
    ai = _RecordingAI()

    async def boom(text: str) -> str:
        raise RuntimeError("model missing")

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", boom
    )
    out = await _localize_text(
        ai, "Hello world, this is a test.", "zh-CN", source_lang="en-US",
    )
    assert ai.calls >= 1, "本地失败应回落 api 三步法"
    assert out == "这是API翻译的译文"
    _set_engine("api", monkeypatch)


@pytest.mark.asyncio
async def test_local_engine_language_guard(monkeypatch) -> None:
    """目标语言非 zh-CN → local 分支不介入，直接走 api。"""
    _set_engine("local", monkeypatch)
    ai = _RecordingAI()
    await _localize_text(
        ai, "Hola mundo.", "ja", source_lang="es",
    )
    assert ai.calls >= 1
    _set_engine("api", monkeypatch)


# ---------- 缓存 ----------


def test_cache_hit_same_narration_and_langs() -> None:
    script = {
        "narration": "hello world",
        "subtitle_zh": "你好世界",
        "_sub_src": "en-US",
        "_sub_tgt": "zh-CN",
    }
    hit = _subtitle_cache_hit(script, "hello world", "en-US", "zh-CN")
    assert hit == "你好世界"


def test_cache_miss_on_changed_narration_or_lang() -> None:
    base = {
        "narration": "hello world",
        "subtitle_zh": "你好世界",
        "_sub_src": "en-US",
        "_sub_tgt": "zh-CN",
    }
    changed = {**base, "narration": "new story"}
    assert _subtitle_cache_hit(changed, "hello world", "en-US", "zh-CN") is None
    lang_changed = {**base, "_sub_tgt": "ja"}
    assert _subtitle_cache_hit(lang_changed, "hello world", "en-US", "zh-CN") is None
    # 打回重制场景：existing_script=None
    assert _subtitle_cache_hit(None, "hello world", "en-US", "zh-CN") is None
    # 空译文不算有效缓存
    empty = {**base, "subtitle_zh": ""}
    assert _subtitle_cache_hit(empty, "hello world", "en-US", "zh-CN") is None
