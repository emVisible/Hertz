"""Narration text → what a voice should actually say (V30).

Two problems this fixes, both measured:

1. Spoken punctuation. Anything that is not Hanzi is routed to an English G2P, and
   espeak happily spells symbols out: a bare `%` came back as `pɚsˈɛnt` ("percent")
   and `**` as `ˈæstɚɹˌsk…` ("asterisk asterisk"). Markdown leftovers, emoji and
   diagram glyphs (→) must never reach the model as letters.

2. Metronome delivery. One flat speed for every beat reads as a recitation. Rate is
   now chosen from the line's own shape (a number-heavy line gets room to land; a
   long plain sentence runs slightly quicker), and the pauses between clauses and
   sentences are widened into a breath rather than a click.
"""
from __future__ import annotations

import re

# Dashes / arrows / ellipses are breaths, never words. A long one keeps its own mark so
# _phrasing can give it the longer gap; a short one collapses to a comma.
_LONGISH = re.compile(r"…+|[—–―]{2,}")
_SHORTISH = re.compile(r"[—–―]|[" + "".join(chr(c) for c in (0x2192, 0x21D2, 0x279C, 0x27A6)) + r"]|-{1,2}>|=>")
# Symbols a G2P will spell out. Kept as a class so nothing sneaks through.
_SPELL = re.compile(r"[*_~`#^|\\\\<>\u2605\u2606\u25cf\u2022\u2027\u00b7\u2023\u25b8\u2192\u2713\u2714\u261e\u261f]+")
# Emoji and other supplementary-plane pictographs (espeak names several of them).
_EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F]+")
# Fullwidth percent → ASCII so the Chinese normalizer reads "92%" as 百分之九十二.
_FW_PCT = re.compile("％")
# A % with no number in front of it is a typo, not "percent".
_BARE_PCT = re.compile(r"(?<![0-9.])%+")
_DUP_COMMA = re.compile(r"[，,]{2,}")
_TRAIL_COMMA = re.compile(r"[，,]\s*([。！？!?])")

# Breaths, in seconds of real silence. Kokoro's own sentence_pause/clause_pause are
# useless here: with is_phonemes=True a comma is not a stop, so a whole line arrives as
# one batch and gets no internal pause at all. We split by clause and insert the gap.
GAP_CLAUSE = 0.20      # ，、；
GAP_SENTENCE = 0.42    # 。！？
GAP_LONG = 0.62        # … or a dash — the "let that land" beat
GAP_HEAD = 0.05
GAP_TAIL = 0.24
# Silence kept from the end of each rendered chunk, so our gap adds to it instead of
# stacking on top of whatever the model already trailed off with.
TRAIL_KEEP = 0.05


# ── V65e: LaTeX read aloud ────────────────────────────────────────────────────────────────
# `$E=mc^2$` used to reach the model as `E=mc2` (every one of `$ ^ \` is in _SPELL below),
# i.e. a formula was pronounced as a typo. This turns the markup into Chinese word order —
# denominator first for `\frac`, 次方 for exponents, 小于等于 for `\le` — and nothing else.
# Unknown commands keep their letters (`\sin` → sin) rather than vanishing silently.
_TEX = {
    "alpha": "阿尔法", "beta": "贝塔", "gamma": "伽马", "delta": "德尔塔", "Delta": "德尔塔",
    "epsilon": "艾普西隆", "zeta": "泽塔", "eta": "伊塔", "theta": "西塔", "kappa": "卡帕",
    "lambda": "拉姆达", "Lambda": "拉姆达", "mu": "缪", "nu": "纽", "xi": "克西",
    "pi": "派", "Pi": "派", "rho": "柔", "sigma": "西格玛", "Sigma": "西格玛", "tau": "陶",
    "phi": "斐", "varphi": "斐", "Phi": "斐", "chi": "希", "psi": "普西", "omega": "欧米伽",
    "Omega": "欧米伽", "times": "乘", "cdot": "乘", "div": "除以", "pm": "正负",
    "approx": "约等于", "equiv": "等价于", "neq": "不等于", "le": "小于等于", "leq": "小于等于",
    "ge": "大于等于", "geq": "大于等于", "ll": "远小于", "gg": "远大于", "infty": "无穷",
    "partial": "偏导", "nabla": "梯度", "sum": "求和", "prod": "连乘", "int": "积分",
    "quad": "", "qquad": "", "left": "", "right": "", "mathrm": "", "text": "", "sim": "约等于",
}
_FRAC = re.compile(r"\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}")
_SUP_SQ = re.compile(r"\^\{?([23])\}?")
_SUP_N = re.compile(r"\^\{?(-?\w+)\}?")
_SUB = re.compile(r"_\{?[^{}\s]+\}?")
_CMD = re.compile(r"\\([A-Za-z]+|[,;:!\\\\ ])")


def _power(f: re.Match[str]) -> str:
    v = f.group(1)
    return f" 的 负 {v[1:]} 次方" if v.startswith("-") else f" 的 {v} 次方"


def speak_math(text: str) -> str:
    """`$…$` spans → words. Everything outside a span is returned untouched."""
    from .display_text import MATH_SPAN, is_math_span, math_body

    def one(m: re.Match[str]) -> str:
        if not is_math_span(m.group(0)):
            return m.group(0)                     # a price, not a formula
        b = math_body(m.group(0))
        for _ in range(2):                        # \frac{\frac{a}{b}}{c} resolves outside-in
            b = _FRAC.sub(lambda f: f"{f.group(2)} 分之 {f.group(1)}", b)
        b = _SUP_SQ.sub(lambda f: " 的平方" if f.group(1) == "2" else " 的立方", b)
        b = _SUP_N.sub(_power, b)
        b = _SUB.sub("", b)
        b = _CMD.sub(lambda f: _TEX.get(f.group(1).strip(), f.group(1)), b)
        b = b.replace("=", " 等于 ").replace("+", " 加 ").replace("<", " 小于 ").replace(">", " 大于 ")
        b = re.sub(r"(?<![\d.])-(?![\d])", " 减 ", b)
        b = re.sub(r"[{}()\[\]|\\]", " ", b)
        return " " + re.sub(r"\s{2,}", " ", b).strip() + " "

    return MATH_SPAN.sub(one, text)


def clean(text: str) -> str:
    """Strip everything that would be spelled out; turn dashes/arrows into pauses."""
    s = speak_math(text or "")
    s = re.sub(r"\s+([。，、！？；：])", r"\1", s)   # the read-aloud gap never belongs before a stop
    s = _FW_PCT.sub("%", s)
    s = _LONGISH.sub("……", s)
    s = _SHORTISH.sub("，", s)
    s = _EMOJI.sub("", s)
    s = _SPELL.sub("", s)
    s = _BARE_PCT.sub("", s)
    s = _DUP_COMMA.sub("，", s)
    s = _TRAIL_COMMA.sub(r"\1", s)
    return re.sub(r"[ \t]{2,}", " ", s).strip()


_DIGITS = re.compile(r"[0-9]+(?:[.,][0-9]+)?")


def rate(text: str) -> float:
    """Per-line speaking rate. Numbers need room to land; long prose can run.

    Bounded to Kokoro's supported 0.5-2.0 and kept near 1.0 so durations stay sane.
    """
    t = clean(text)
    n = len(re.sub(r"\s", "", t))
    if n == 0:
        return 1.0
    digits = sum(len(m.group(0)) for m in _DIGITS.finditer(t))
    if digits / n > 0.25 or n <= 8:          # a stat-like line: slow it down
        return 0.90
    if n >= 34:                              # a long sentence: a touch quicker
        return 1.04
    return 0.97
