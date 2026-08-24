"""制作前预检测试（v0.22.x D-190）：阻断/警告矩阵 + 标志归一单一真相源。"""

from backend.pipeline.helpers import normalize_produce_flags
from backend.pipeline.preflight import plan_capability_checks

# ---------- 标志归一（与 media._produce_item 同源语义） ----------


def test_normalize_empty_defaults_to_passthrough() -> None:
    flags = normalize_produce_flags(None)
    assert flags == {
        "passthrough": True, "voice": False, "subtitle": False,
        "translate": False, "mute": False,
    }


def test_normalize_partial_set_keeps_v09_semantics() -> None:
    """部分设置（如只开 voice）→ subtitle/translate 默认补真（v0.9 语义）。"""
    flags = normalize_produce_flags({"voice": True})
    assert flags["voice"] is True and flags["subtitle"] is True and flags["translate"] is True


def test_normalize_all_bool_coerced() -> None:
    flags = normalize_produce_flags({"passthrough": 1, "mute": "yes"})
    assert flags["passthrough"] is True and flags["mute"] is True


# ---------- 预检矩阵 ----------


def _plan(opts, *, local_mt=True, tts=None, asr=True, llm=True):
    return plan_capability_checks(
        opts,
        local_mt_ready=local_mt,
        tts_available=tts,
        asr_available=asr,
        llm_ok=llm,
    )


def test_passthrough_never_blocks() -> None:
    blockers, warnings = _plan(
        {"passthrough": True}, local_mt=False, tts=False, asr=False, llm=False,
    )
    assert blockers == []
    assert any("LLM" in w for w in warnings)


def test_translate_requires_local_mt_blocker() -> None:
    """用户拍板的核心语义：翻译开而本地引擎未就绪 → 阻断（产出必不符预期）。"""
    blockers, _ = _plan(
        {"subtitle": True, "translate": True},
        local_mt=False, tts=True, asr=True, llm=True,
    )
    assert len(blockers) == 1 and "翻译" in blockers[0]
    # 引擎就绪 → 无阻断
    blockers2, _ = _plan(
        {"subtitle": True, "translate": True},
        local_mt=True, tts=True, asr=True, llm=True,
    )
    assert blockers2 == []


def test_voice_tts_unconfigured_blocks() -> None:
    blockers, _ = _plan(
        {"voice": True, "subtitle": True, "translate": False},
        tts=False, asr=True, llm=True,
    )
    assert any("TTS" in b for b in blockers)


def test_voice_tts_unknown_warns_not_blocks() -> None:
    # 未知（None）按警告放行——阻断仅保留给「确认不可用」
    blockers, warnings = _plan(
        {"voice": True, "subtitle": True, "translate": False},
        tts=None, asr=True, llm=True,
    )
    assert not any("TTS" in w for w in warnings) or any("未知" in w for w in warnings)
    assert blockers == []


def test_subtitle_without_asr_warns_only() -> None:
    """ASR 不可用有旁白兜底 → 警告放行（非破坏性），不阻断。"""
    blockers, warnings = _plan(
        {"subtitle": True, "translate": False},
        tts=True, asr=False, llm=True,
    )
    assert blockers == []
    assert any("ASR" in w for w in warnings)


def test_llm_missing_warns_on_processed_paths() -> None:
    _, warnings = _plan(
        {"voice": True, "subtitle": True, "translate": True},
        tts=True, asr=True, llm=False,
    )
    assert any("LLM" in w for w in warnings)
