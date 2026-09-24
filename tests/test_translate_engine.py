"""v0.22.x 翻译引擎与缓存测试：本地单引擎 / 失败回原文 / 缓存命中与失效。

翻译去 API 化（D-189）后语义：Opus-MT 为唯一引擎，任何失败回退原文。
"""

import pytest

from backend.pipeline.producers.media import (
    _localize_text,
    _subtitle_cache_hit,
)

# ---------- 引擎分支 ----------


@pytest.mark.asyncio
async def test_local_translate_success(monkeypatch) -> None:

    async def fake_translate(text: str) -> str:
        return "楼下的灯还亮着。"

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", fake_translate
    )
    out = await _localize_text(
        "The lamp downstairs stays on late.", "zh-CN", source_lang="en-US",
    )
    assert isinstance(out, str) and out.strip()


@pytest.mark.asyncio
async def test_local_failure_falls_back_to_original(monkeypatch) -> None:
    """D-189 新语义：本地引擎失败 → 回原文（不再有 api 三步法回落）。"""

    async def boom(text: str) -> str:
        raise RuntimeError("model missing")

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", boom
    )
    original = "Hello world, this is a test."
    out = await _localize_text(original, "zh-CN", source_lang="en-US")
    assert "Hello world" in out


@pytest.mark.asyncio
async def test_language_guard_non_en_zh_pair_returns_original(monkeypatch) -> None:
    """语言对守卫：非 en→zh 组合 local 不介入，直接返回原文。"""
    called = {"n": 0}

    async def fake_translate(text: str) -> str:
        called["n"] += 1
        return "不应被调用"

    monkeypatch.setattr(
        "backend.pipeline.producers.translate_engine.translate_local", fake_translate
    )
    original = "Hola mundo."
    out = await _localize_text(original, "ja", source_lang="es")
    assert out == original
    assert called["n"] == 0


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
