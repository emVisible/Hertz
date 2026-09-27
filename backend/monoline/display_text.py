"""V48: the single contract for text that gets DISPLAYED on a slide.

Before this, punctuation rules lived in 11 separate regexes/`strip` calls inside
`pipeline/planner.py` (+ `segment.py`, + two audio-only dedupe rules in `narration.py`
that no display path ever imported), and templates/CSS had none. Measured on the real
corpus (43 jobs / 311 beats): 43 display strings (13.8%) ended in punctuation, 17 (5.5%)
ended mid-clause on 「，、：」, and 4 had a quote mark with no partner because the pair
was split across two beats.

The rule we implement is GB/T 15834-2011 附录 B.4: a title/heading carries no terminal
punctuation — except ？, ！ and …, which are part of the wording, not a sentence marker.
W3C clreq adds that a display line must not open with punctuation either. Everything here
is that narrow: we never rewrite wording, we only drop marks that carry no meaning at the
end of a display line, and we drop quote marks that were orphaned by segmentation.

Applied at the two places that GENERATE text (RulePlanner.plan, llm.planner.merge). Not on
the manual PATCH path: a slot the user typed by hand is what they asked for, and silently
eating a character they typed is a worse surprise than the mark itself.
"""
from __future__ import annotations

import re
from collections.abc import Callable

# marks that may never END a display line. ASCII '.' is deliberately absent so "v1.2" and
# "3.5" survive, and ？ ！ … are absent because they carry the line's meaning (GB/T B.4);
# a trailing '-' is a split artefact, so it goes.
_STRIP_END = "。，,、：:；;·—–-"

_DUP = ((re.compile(r"[，,]{2,}"), "，"), (re.compile(r"。{2,}"), "。"),
        (re.compile(r"[，,]。"), "。"), (re.compile(r"。[，,]"), "。"),
        (re.compile(r"、{2,}"), "、"), (re.compile(r"[：:]{2,}"), "："),
        (re.compile(r"[？?]{2,}"), "？"), (re.compile(r"[！!]{2,}"), "！"))
_LEAD = re.compile(r"^[\s。，、：:；;·…—–~～”」』)）]+")

_CLOSERS = "”」』）)"
_OPENERS = "“「『（("

# slots that are display text at all. Everything else in a scene's slots is a machine
# value (icon name, asset path, verbatim flag) and must not be touched.
DISPLAY_KEYS = ("headline", "sub", "title", "term", "gloss", "label", "value", "unit",
                "q", "attr", "body", "hub", "tab", "by", "tagline", "x_axis", "y_axis",
                "eyebrow", "image_caption")
LIST_KEYS = ("items", "nodes", "steps", "layers", "cells", "series")


def balance_quotes(t: str) -> str:
    """Drop a quote mark whose partner never arrived — the pair was cut apart by the
    segmenter, so on screen it reads as a typo, not as an open quotation."""
    while t and t[-1] in _CLOSERS and t.count("“") < t.count("”"):
        t = t[:-1].rstrip()
    while t and t[-1] in _OPENERS and t.count("“") > t.count("”"):
        t = t[:-1].rstrip()
    while t and t[0] in _OPENERS and t.count("“") > t.count("”"):
        t = t[1:].lstrip()
    return t


_UNIT = re.compile(r"[^\s，、：；,;]+[，、：；,;]*\s*")


def kinetic_chunks(text: object, *, min_groups: int = 3, group: int = 2,
                   max_groups: int = 24, min_chars: int = 8) -> list[str]:
    """Reveal units for the kinetic headline, or [] to leave the plain wipe in place.

    Clause first — that is where the narration breathes. When a line is one long clause the
    text falls back to fixed 2-character groups: per character on a 20-char headline reads
    as a typewriter crawl, and no split at all is just a fade. Joining the result always
    reproduces the input, so the markup cannot lose a character or a space.

    [] above `max_groups` units: past ~24 masked boxes the DOM costs more than the effect
    buys, and a crawl is what the audience would see anyway.
    """
    t = " ".join(str(text or "").split())
    if len(t) < min_chars:
        return []
    if has_math(t):
        # A formula must arrive as one unit: a reveal box cutting `$\frac{1}{2}$` in half
        # paints a broken span, and KaTeX never sees it. Plain wipe instead.
        return []
    parts = [p for p in _UNIT.findall(t) if p]
    if len(parts) >= min_groups:
        return parts if len(parts) <= max_groups else []
    out = [t[i:i + group] for i in range(0, len(t), group)]
    return out if len(out) <= max_groups else []


# A beat that stops on one of these is half a thought: the segmenter had to cut a long sentence
# because it exceeds the per-beat budget.  Templates read this to paint such a line as a lead-in
# instead of as the slide's headline — 18% of beats in the real corpus do this (measured 2026-09-26).
_OPEN_END = "，,、：:；;—–"


def ends_open(text: object) -> bool:
    """True when the beat's own text breaks off mid-sentence (never on the tidied display copy,
    which has already lost its terminal mark)."""
    t = str(text or "").strip()
    return bool(t) and t[-1] in _OPEN_END


# ── V66: 上屏「去虫」而不是「去标点」（用户 2026-09-26 纠正 V62b 的表述）────────────────────
# 之前做成「所有标点换成空格」，把标题里的「？」、引号、破折号一起抹掉了 —— 那些是表达本身。
# 现在的边界只有一条：**只清首尾**。首尾的逗号/句号/顿号/冒号是切分与复制留下的虫；句中的
# 标点原样留着。至于「该不该被听见」，那是 `narration.clean` 的职责（标点变停顿，不念出名字），
# 与画面上有没有它无关。
_EDGE = _STRIP_END
_DUP_RUN = re.compile(r"([，、：；])\s*(?:[，、：；]\s*)+")
_WS_RUN = re.compile(r"[ \t]{2,}| *\n *")

# A `$…$` / `$$…$$` span is a formula: its braces, commas and digits are notation, so every
# rule in this module (and the planner's numeric rules) must treat it as one opaque atom.
# Deliberately conservative, because a false positive costs more than a miss — `售价 $100 起`
# and `$100与$200` are money, not math, and masking them would hide a real statistic. So a
# span only counts as math when it holds no CJK character and at least one math mark.
MATH_SPAN = re.compile(r"\$\$[^$\n]+?\$\$|\$(?![\s$])[^$\n]+?\$")
_CJK_CHAR = re.compile(r"[　-〿一-鿿＀-￯]")
_MATH_MARK = re.compile(r"[=^_\\{}%]")


def math_body(span: str) -> str:
    """The formula itself, without its `$` delimiters."""
    return span[2:-2] if span.startswith("$$") else span[1:-1]


def is_math_span(span: str) -> bool:
    body = math_body(span)
    return bool(body) and not _CJK_CHAR.search(body) and bool(_MATH_MARK.search(body))


def has_math(text: object) -> bool:
    return any(is_math_span(m.group()) for m in MATH_SPAN.finditer(str(text or "")))


def outside_math(text: object, fn: Callable[[str], str]) -> str:
    """Apply `fn` to every run that is not a formula; the formulas pass through untouched."""
    t = str(text or "")
    out: list[str] = []
    pos = 0
    for m in MATH_SPAN.finditer(t):
        if not is_math_span(m.group()):
            continue
        out.append(fn(t[pos:m.start()]))
        out.append(m.group())
        pos = m.end()
    out.append(fn(t[pos:]))
    return "".join(out)


def mask_math(text: object, repl: str = "▮") -> str:
    """Formulas replaced by one block glyph — for DETECTION only, never for display."""
    return MATH_SPAN.sub(lambda m: repl if is_math_span(m.group()) else m.group(),
                         str(text or ""))


def detonate(text: object) -> str:
    """One visible string → the same sentence with its EDGE punctuation de-bugged.

    Mid-sentence marks survive on purpose: 「这不是反射阳光，而是一场化学反应」 painted without
    its comma reads as two unrelated claims, and a title's 「？」 is the point of the slide.
    """
    t = str(text or "")
    if not t.strip():
        return ""
    t = outside_math(t, lambda r: _WS_RUN.sub(" ", r))
    t = _DUP_RUN.sub(r"\1", t)
    t = _LEAD.sub("", t)
    t = balance_quotes(t)          # orphan quote left behind by the segmenter
    t = t.rstrip(_EDGE)
    return t.strip()


def tidy(text: object, *, hero: bool = True) -> str:
    """One display string → what may be painted. Never rewrites wording."""
    t = str(text or "").strip()
    if not t:
        return ""
    for pat, rep in _DUP:
        t = pat.sub(rep, t)
    t = _LEAD.sub("", t)
    # balance first: "他们。”" only exposes its terminal mark once the orphan quote is gone
    t = balance_quotes(t)
    if hero:
        t = t.rstrip(_STRIP_END)
    return detonate(t)


def tidy_slots(kind: str, slots: dict) -> dict:
    """Apply the contract to one scene in place of the 11 scattered strips.
    Returns the dict (mutated copy) so callers can pipe it straight through."""
    if not isinstance(slots, dict):
        return slots
    out = dict(slots)
    for key in DISPLAY_KEYS:
        v = out.get(key)
        if isinstance(v, str) and v:
            out[key] = tidy(v)
    for key in LIST_KEYS:
        v = out.get(key)
        if isinstance(v, list):
            out[key] = [tidy(x) for x in v]
    for key in ("rows", "stages"):
        v = out.get(key)
        if isinstance(v, list):
            rows = []
            for r in v:
                if isinstance(r, dict):
                    rr = dict(r)
                    for rk in ("k", "v", "t"):
                        if isinstance(rr.get(rk), str):
                            rr[rk] = tidy(rr[rk])
                    rows.append(rr)
                else:
                    rows.append(tidy(r))
            out[key] = rows
    for side in ("a", "b"):
        v = out.get(side)
        if isinstance(v, dict):
            vv = dict(v)
            for sk in ("h", "d"):
                if isinstance(vv.get(sk), str):
                    vv[sk] = tidy(vv[sk])
            out[side] = vv
    return out
