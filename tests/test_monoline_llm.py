"""Monoline 融合域 B1/B3：LLM 升格纯逻辑 + TaskRouter 接线（fake ai，不联网）。"""

import json

from backend.monoline.llm_plan import (
    _batches,
    build_prompt,
    merge,
    suggest,
    upgrade,
)


class FakeAI:
    def __init__(self, responses: list[str], fail: bool = False) -> None:
        self.responses = list(responses)
        self.fail = fail
        self.calls = 0

    async def chat_messages(self, messages, **kw) -> str:
        self.calls += 1
        if self.fail:
            raise RuntimeError("provider down")
        return self.responses.pop(0)


def _scenes(n: int, kind: str = "statement") -> list[dict]:
    return [{"i": i, "kind": kind, "source": "rules", "slots": {}} for i in range(n)]


def test_merge_counts_verdicts() -> None:
    beats = ["本拍年份是2026年", "纯文字拍", "纯文字拍"]
    scenes = _scenes(3)
    payload = {"scenes": [
        {"i": 0, "kind": "stat", "slots": {"value": "2026年", "label": "年份"}},
        {"i": 1, "kind": "statement", "slots": {}},
        {"i": 2, "kind": "flying", "slots": {}},
    ]}
    out, stats = merge(beats, scenes, payload)
    assert stats["upgraded"] == 1 and out[0]["kind"] == "stat"
    assert out[0]["source"] == "llm:upgrade"
    assert stats["declined"] == 1
    assert stats["bad_kind"] == 1
    assert stats["rejected"] == 1


def test_merge_rejects_invented_and_dangling() -> None:
    beats = ["核心是创新"]
    scenes = _scenes(1)
    payload = {"scenes": [{"i": 0, "kind": "definition",
                           "slots": {"term": "无中生有的词", "gloss": "核心是"}}]}
    out, stats = merge(beats, scenes, payload)
    assert stats["bad_slots"] >= 1 and out[0]["kind"] == "statement"


def test_merge_never_changes_count() -> None:
    beats = ["a", "b"]
    scenes = _scenes(2)
    out, _ = merge(beats, scenes, {"scenes": [{"i": 0, "kind": "stat",
                                               "slots": {"value": "a", "label": "b"}}] * 5})
    assert len(out) == 2


def test_batches_respect_budgets() -> None:
    items = [(i, "x" * 100) for i in range(10)]
    batches = _batches(items, beats=3, chars=900)
    assert sum(len(b) for b in batches) == 10
    assert all(len(b) <= 3 for b in batches)


def test_build_prompt_single_object() -> None:
    msgs = build_prompt([(0, "第一拍"), (2, "第三拍")])
    assert msgs[0]["role"] == "system" and "scenes" in msgs[0]["content"]
    assert "0. 第一拍" in msgs[1]["content"]


async def test_upgrade_applies_and_counts() -> None:
    beats = ["2026年登月", "纯文字拍"]
    scenes = _scenes(2)
    ai = FakeAI([json.dumps({"scenes": [
        {"i": 0, "kind": "stat", "slots": {"value": "2026年", "label": "登月"}},
        {"i": 1, "kind": "statement", "slots": {}}]})])
    out, stats = await upgrade(ai, beats, scenes, model="test")
    assert out[0]["kind"] == "stat" and stats["upgraded"] == 1
    assert stats["declined"] == 1 and stats["model"] == "test"
    assert ai.calls == 1  # 两弱拍一批


async def test_upgrade_failure_keeps_rules() -> None:
    beats = ["纯文字拍"]
    scenes = _scenes(1)
    out, stats = await upgrade(FakeAI([], fail=True), beats, scenes, model="test")
    assert out == scenes and stats["failed_batches"] == 1


async def test_suggest_cached_second_time(tmp_path, monkeypatch) -> None:
    from backend.monoline import llm_plan as llm_plan_mod

    monkeypatch.setattr(llm_plan_mod, "_suggest_cache_dir", lambda: tmp_path / "s")
    ai = FakeAI([json.dumps({"scenes": [
        {"i": 0, "kind": "quote", "slots": {"q": "纯文字拍"}}]})])
    v1 = await suggest(ai, "纯文字拍", _scenes(1)[0], model="m", timeout_s=30)
    assert v1["status"] == "changed" and v1["cached"] is False
    assert ai.calls == 1
    v2 = await suggest(ai, "纯文字拍", _scenes(1)[0], model="m", timeout_s=30)
    assert v2["cached"] is True and ai.calls == 1
    assert v2["kind"] == "quote"


async def test_suggest_unanswered_on_failure(tmp_path, monkeypatch) -> None:
    from backend.monoline import llm_plan as llm_plan_mod

    monkeypatch.setattr(llm_plan_mod, "_suggest_cache_dir", lambda: tmp_path / "s2")
    v = await suggest(FakeAI([], fail=True), "纯文字拍", _scenes(1)[0],
                      model="m", timeout_s=30)
    assert v["status"] == "unanswered" and v["error"]


class _SuggestAI:
    """suggest() 经 upgrade() 走 chat_messages；此处直接喂 verdict 载荷。"""

    def __init__(self, payload: dict) -> None:
        import json as _json

        self.payload = _json.dumps(payload)
        self.calls = 0

    async def chat_messages(self, messages, **kw) -> str:
        self.calls += 1
        return self.payload


async def test_breakout_upgrades_mid_of_long_run(tmp_path, monkeypatch) -> None:
    from backend.monoline import runner as R

    monkeypatch.setattr(R, "suggest", _fake_suggest_changed())
    beats = [f"第{i}拍纯文字" for i in range(5)]
    scenes = [{"i": i, "kind": "statement", "source": "rules", "slots": {}} for i in range(5)]
    logged: list[str] = []

    async def _log(msg: str, **kw) -> None:
        logged.append(msg)

    mid = await R._breakout_long_run(object(), beats, scenes, model="m", log=_log)
    assert mid == 2
    assert scenes[2]["kind"] == "quote" and scenes[2]["source"] == "llm:breakout"
    assert any("破格" in m for m in logged)


async def test_breakout_skips_short_run() -> None:
    from backend.monoline import runner as R

    beats = ["a", "b", "c"]
    scenes = [{"i": i, "kind": "statement", "source": "rules", "slots": {}} for i in range(3)]
    assert await R._breakout_long_run(object(), beats, scenes, model="m") is None


def _fake_suggest_changed():
    async def _suggest(ai, beat: str, scene: dict, *, model: str, **kw) -> dict:
        return {"status": "changed", "kind": "quote", "slots": {"q": beat[:6]},
                "model": model, "seconds": 1.0, "why": [], "error": "", "cached": False}

    return _suggest


def test_position_factor_shape() -> None:
    from backend.monoline.runner import position_factor

    assert position_factor(0, 1) == 1.0
    assert position_factor(0, 5) == 0.95
    assert position_factor(4, 5) == 0.97
    assert position_factor(2, 5) == 1.02


def test_append_silence_extends(tmp_path) -> None:
    import numpy as np
    import soundfile as sf

    from backend.monoline.runner import append_silence

    p = tmp_path / "x.wav"
    sf.write(str(p), np.zeros(22050, dtype="float32"), 22050)
    assert append_silence(p, 0.4) == 1.4
