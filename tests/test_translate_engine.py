"""v0.22.x 翻译引擎与缓存测试：本地单引擎 / 失败回原文 / 缓存命中与失效。

翻译去 API 化（D-189）后语义：Opus-MT 为唯一引擎，任何失败回退原文。
"""

import re as _re
from pathlib import Path as _Path

import pytest

from backend.config import settings as _settings
from backend.infrastructure import paths as _paths
from backend.pipeline.producers import translate_engine as _te
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


# ---------- D-234：解码退化护栏 ----------
#
# 这一族的共同形状是**不报错**：循环译文是合法字符串，字幕文件正常生成、
# 能烧进成片。所以判据不能测「没抛异常」，要直接量重复本身。

_LOOP_RE = _re.compile(r"(.{2,}?)\1{2,}")
_CHAR_RUN_RE = _re.compile(r"(.)\1{4,}")

# 2026-10-19 用户合集字幕 subs.ass 里的事故现场原样（截取自成片）
_PRODUCTION_LOOPS = [
    "你在做什么 你在做什么",
    "你他妈在干你干什么 你他妈的在干你干什么 你他妈在干你干什么 你他妈在干你干什么",
    "失失的空空空空空空空空",
    "你被完全覆盖 你完全被完全覆盖 你被完全覆盖 你被完全覆盖了 被报道的 "
    "被你被完全覆盖的 被报道的 被你完全覆盖的 被你完全覆盖的 被全你完全覆盖的 "
    "被报道的 被报道的 被你完全覆盖的 被你完全覆盖的 被报道的",
    "正在按在 " + "正在 " * 120 + "在",
    "她看不见" + "看不见," * 200,
]

_NORMAL_ZH = [
    "说实话,这是整个视频录像中最棒的部分。",
    "她无法相信接下来发生了什么, 我也不能... 我也也不可能",
    "不要忘了, 也想更多的影片訂閱、喜歡和訂入。",
    "我们要测试三种不同的方法 并看看谁赢一个,看哪个赢了...",
    "他走进厨房,打开窗户窗的窗口。",
    "这是一个很长的正常句子，里面没有任何重复的内容，可以放心通过。",
    # 4 连笑声是人话：折叠的 5 连下限不动它，密度的同字 gram 排除也不算它
    "他笑得哈哈哈哈，然后我们才回家吃饭。",
    # 真实机翻的中等输出（密度 0.314）：有轻微「窗窗窗」但全是内容，
    # 截断会丢意思——阈值必须站在它**上面**，这是 0.35 的下界
    "他走进厨房,打开窗户窗的窗口。 .他走到厨房后,走到厨房,然后开着玻璃窗"
    "就一进厨房,向窗窗门开了窗窗窗。",
]


def test_collapse_repetition_folds_production_loops() -> None:
    """事故现场六条过完整护栏链后必须干净——这条不过，字幕上就还是「正在 正在 正在」。

    断的是链（折叠+截断，即引擎出口实际跑的两步），不是单步：2 连的
    「你在做什么 你在做什么」本就归密度截断管，折叠的下限是 3 连。
    """
    for raw in _PRODUCTION_LOOPS:
        out = _te._trim_degenerate(_te._collapse_repetition(raw))
        assert not _LOOP_RE.search(out), f"仍有循环段：{out[:60]!r}"
        assert not _CHAR_RUN_RE.search(out), f"仍有同字连排：{out[:60]!r}"
        assert _te._dup_ratio(out) < 0.35, f"仍有回声：{out[:60]!r}"
        assert len(out) < len(raw), f"没真收敛：{raw[:40]!r}"


def test_collapse_repetition_keeps_legit_repeats() -> None:
    """下限是刻意的：3–4 连单字与正常句不许动（「哈哈哈哈」是人话）。"""
    for text in ["哈哈哈哈", "不不不", *_NORMAL_ZH]:
        assert _te._collapse_repetition(text) == text


def test_dup_ratio_separates_normal_from_degenerate() -> None:
    """阈值定标判据：正常族密度 < 阈值 ≤ 需要截断的样本密度（折叠后）。

    双向改必红——调高到 10.0：事故样本这条过不了；调低到 0.30：真实机翻
    那条 0.314 会被误伤。阈值不是拍的，是夹在两族之间量出来的。
    """
    for text in _NORMAL_ZH:
        assert _te._dup_ratio(text) < _te._DUP_RATIO_THRESHOLD, (
            f"正常句密度 {_te._dup_ratio(text):.3f} 越过阈值，会被截断：{text!r}"
        )
    # 折叠抓不住、只能靠密度门接的三条（2 近似重复 + 1 三连）
    for i in (0, 1, 3):
        folded = _te._collapse_repetition(_PRODUCTION_LOOPS[i])
        assert _te._dup_ratio(folded) >= _te._DUP_RATIO_THRESHOLD, (
            f"事故样本 [{i}] 折叠后密度不足，门不会开：{folded[:40]!r}"
        )


def test_dup_ratio_ignores_uniform_grams() -> None:
    """同字 gram 不计——「哈哈哈哈哈哈哈哈」这种均匀串不算回声。

    单字连排归折叠管（≥5 连即折），密度只管多字短语的回声；这条钉住
    `_dup_ratio` 声称的口径，改回无差别计数必红。
    """
    assert _te._dup_ratio("哈哈哈哈哈哈哈哈") == 0.0
    assert _te._dup_ratio("空空空空空空空空") == 0.0
    # 同样长度的多字回声照算
    assert _te._dup_ratio("看不见看不见看不见看不见") >= 0.35


def test_trim_degenerate_cuts_near_repetition_at_word_boundary() -> None:
    """逐字差一点的近似重复折叠抓不住 → 密度截断接住，且收口在词边界。"""
    near = _PRODUCTION_LOOPS[3]
    out = _te._trim_degenerate(_te._collapse_repetition(near))
    assert out == "你被完全覆盖", f"应在词边界收口，实得 {out!r}"
    assert _te._dup_ratio(out) < 0.35


def test_trim_degenerate_leaves_normal_text_alone() -> None:
    for text in _NORMAL_ZH:
        assert _te._trim_degenerate(text) == text


def test_translate_kwargs_wire_anti_loop_params() -> None:
    """接线守卫：参数写进去才算修——退回去（删 repetition_penalty 等）必红。"""
    kw = _te._translate_kwargs([["a"] * 140])
    assert kw["repetition_penalty"] == 1.5
    assert kw["no_repeat_ngram_size"] == 3
    assert kw["disable_unk"] is True
    # ct2 默认 256 会把长段落截在半句上，必须按源长度放开
    assert kw["max_decoding_length"] > 256
    # 短句也不许无上限（退化循环会一路烧到超长）
    assert _te._translate_kwargs([["x"]])["max_decoding_length"] <= 2048


@pytest.fixture
def repo_data_dir(monkeypatch):
    """把 data_dir 指回仓库 data/。

    conftest 把 HERTZ_DATA_DIR 隔到 tmp——那样 local_mt_ready() 恒 False，
    端到端判据会**永远跳过**、等于没有。这里只读模型，不写不下载
    （不就绪时下面先 skip，根本不会调到 ensure_model 的下载分支）。
    """
    root = _Path(__file__).resolve().parents[1] / "data"
    monkeypatch.setattr(_settings, "data_dir", str(root))
    return root


@pytest.mark.asyncio
async def test_engine_emits_no_repetition_loops(repo_data_dir) -> None:
    """端到端：真实模型 + 默认会退化的那批源文，一条循环都不许出去。

    注意这条**接不住**参数回退——参数退回 ct2 默认时，两道后处理兜底会把
    循环照样拦掉，端到端照绿（实测 1 red 是 `test_translate_kwargs_wire_anti_loop_params`
    这条接线守卫）。三层各有各的判据，别指望端到端一条压住全部（D-234）。
    """
    if not _paths.local_mt_ready():
        pytest.skip("本地翻译模型不在仓库 data/models——端到端判据只在有模型的机器上跑")

    sources = [
        "Dumbling",
        "she can't see",
        "Dumbling what are you doing?",
        "What the fuck are you doing you",
        "You're totally covered Dumbling Dumbling",
        "He walked into the kitchen and opened the window.",
        "This is the best part of the whole video, honestly.",
        "She couldn't believe what happened next, and neither could I.",
        "We're going to test three different methods and see which one wins.",
        "Don't forget to like and subscribe for more videos like this.",
        "The lamp downstairs stays on late every night this week.",
    ]
    outs = await _te.translate_batch_local(sources)
    for src, out in zip(sources, outs, strict=True):
        assert not _LOOP_RE.search(out), f"循环译文：{src!r} -> {out[:80]!r}"
        assert not _CHAR_RUN_RE.search(out), f"同字连排：{src!r} -> {out[:80]!r}"
        assert _te._dup_ratio(out) < 0.35, f"重复密度过高：{src!r} -> {out[:80]!r}"
        assert len(out) <= max(160, len(src) * 6), f"长度失控：{src!r} -> {out!r}"
