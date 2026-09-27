"""Segmentation strategy — turn arbitrary pasted text into well-sized beats.

The M1 failure was "one line = one beat": a pasted paragraph became a single
37s wall-of-text caption. This splits into sentence-level beats with a length
budget, while RESPECTING the user's explicit line breaks as strong boundaries.

Pluggable: `Segmenter` protocol; `SentenceSegmenter` is the v1 (only) impl.
LLM semantic segmentation can drop in later behind the same interface.
"""
from __future__ import annotations

import re
from typing import Protocol

# Sentence-final punctuation (CJK + latin). Keep the mark attached to the beat.
# Latin "." splits only when followed by whitespace → decimals ("3.14", "$5.5") stay intact.
# NOTE: ；/; are NOT sentence-final — they separate clauses (e.g. "命中：68%；覆盖：42%"),
# so splitting there would shred structured k:v lines into single-number fragments.
_SENT_SPLIT = re.compile(r"(?<=[。！？!?…])|(?<=\.)(?=\s)")
# Secondary split for over-long sentences (clause boundaries, incl. semicolons).
_CLAUSE_SPLIT = re.compile(r"(?<=[，,、：:；;])")
_WS = re.compile(r"\s+")
# Leading markdown/list markers people paste (headers "# ", bullets "- • ·", "1."/"2)"/"1、").
# Stripped so the marker never leaks into a headline/caption/TTS and "2. x" isn't misread
# as a stat. Requires trailing whitespace → leaves "3.14", "-10%" and "C#" intact.
_LIST_MARK = re.compile(r"^\s*(?:#{1,6}|[-*+•·‣⁃]|\d+[.)、])\s+")
# Anything a voice could actually say. Rules written with the delimiter only (`---`, `***`)
# are markup, not content; `_` is deliberately excluded so `___` is not read as a word.
_WORD = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")

# Markdown inline syntax people paste (from docs / LLM output) → keep the visible text,
# drop the markup so it never leaks onto the slide or into TTS.
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_STRONG = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_MD_EM = re.compile(r"(?<![*\w])\*([^*\n]+?)\*(?![*\w])")
_MD_CODE = re.compile(r"`([^`]+)`")

# A colon that introduces an arrow chain is a SLIDE boundary: the lead-in is a sentence and
# the tail is a diagram. Left fused, the planner can only ever see one of them (1 beat = 1
# scene), so the diagram gets thrown away as a headline. k:v lines and 、-enumerations are
# deliberately NOT split — the planner reads those whole (table / radial).
_ARROWISH = re.compile(r"→|⇒|➜|➦|--+>|=>|->")
_COLON = re.compile(r"^(.{4,}?)\s*[:：]\s*(.+)$", re.S)

# How far past max_chars a beat may grow to avoid a bad cut (see _split_long). 1.6× keeps the
# longest beats inside the two-line headline the templates already support (measured: 36 字 fits).
CEIL_FACTOR = 1.6
# These opening words mean the clause before them is a setup, not a point: cutting here would
# strand "不是 A" on one screen and "而是 B" on the next.
_CONTINUATION = re.compile(r"^\s*(而|但|却|也|还|更|于是|所以|并且|而且|然后|接着|甚至|不过|因为|如果|而是|就是)")
# A trailing stub (a date, an ordinal, one k:v pair) is not a place a screen can end on.
_STUB = re.compile(r"^\d{4}年|^[\d一二三四五六七八九十]{1,4}[月日]|^第[\d一二三四五六七八九十]{1,3}[步条章节]$")


def _bad_cut(cur: str, nxt: str) -> bool:
    """Is closing a beat right here the wrong call? See _split_long."""
    if _CONTINUATION.match(nxt):
        return True
    # _CLAUSE_SPLIT is a zero-width lookbehind split, so a string that ends on a clause mark
    # yields a trailing EMPTY part — taking [-1] without dropping empties makes every cut look
    # like a stub. That version of this predicate was vacuously true and packed to the ceiling.
    parts = [c for c in _CLAUSE_SPLIT.split(cur) if c.strip()]
    if not parts:
        return True
    last = _WS.sub("", re.sub(r"[，,、：:；;]$", "", parts[-1].strip()))
    return len(last) <= 6 or bool(_STUB.match(last))


def _strip_md(s: str) -> str:
    s = _MD_LINK.sub(r"\1", s)
    s = _MD_STRONG.sub(lambda m: m.group(1) if m.group(1) is not None else m.group(2), s)
    s = _MD_EM.sub(r"\1", s)
    s = _MD_CODE.sub(r"\1", s)
    return s


class Segmenter(Protocol):
    def segment(self, text: str) -> list[str]: ...


# Beat-count ceiling for one job, and the narration rate the UI's ≈duration is derived from.
# Both live here because /api/script/preview reports the same numbers the pipeline enforces
# — a second copy in the route is how the old TypeScript estimate ended up 30% wrong.
HARD_CAP = 1200
SECONDS_PER_BEAT = 2.6


class SentenceSegmenter:
    """min/max are in CJK-equivalent characters (latin runs count loosely).

    hard_cap is a "this is a book, not a script" guard, NOT a per-job length limit: a long
    paste is segmented line by line whatever its size, and the model side batches it
    (llm.planner.upgrade) so a small local model never receives the whole thing at once.

    It has to sit above what a real article produces. Measured: a 6788-char paste came out
    at 248 beats and hit the old 240 ceiling, i.e. the guard rejected the exact input this
    tool exists for. 1200 beats ≈ 33k characters ≈ 52 minutes of narration — past that the
    paste is a manuscript, and a job that long would fail in render (frame count, disk)
    rather than here, which is the wrong place to discover it.

    `hard_cap=None` removes the guard. The preview endpoint counts with it off: it has to
    report the number a manuscript-sized paste *would* produce in order to warn about it,
    and re-raising here would make the caller parse a message to recover that number.
    """

    def __init__(self, *, min_chars: int = 6, max_chars: int = 40,
                 hard_cap: int | None = HARD_CAP) -> None:
        self.min_chars = min_chars
        self.max_chars = max_chars
        self.hard_cap = hard_cap

    def _len(self, s: str) -> int:
        return len(_WS.sub("", s))

    def _split_long(self, s: str) -> list[str]:
        """Recursively split an over-budget sentence on clause punctuation.

        The cut point matters more than the cut: measured over 42 stored scripts (595 beats),
        143 beats end on a clause mark, and 39 of those are bad *choices* rather than an
        unavoidable consequence of splitting at all — a 6-char stub like 「9月24日，」 closing a
        beat, or the next beat opening on 「而是…」. Both are fixed by absorbing the clause
        forward instead of closing here, up to `ceil_chars`; past that the layout would get a
        paragraph it cannot fit, so the original cut wins.
        """
        if self._len(s) <= self.max_chars:
            return [s]
        parts = [p for p in _CLAUSE_SPLIT.split(s) if p and p.strip()]
        if len(parts) <= 1:
            return [s]  # no clause boundary; keep as-is (a long word/number)
        ceil_chars = int(self.max_chars * CEIL_FACTOR)
        out: list[str] = []
        cur = ""
        for _idx, p in enumerate(parts):
            if cur and self._len(cur) + self._len(p) > self.max_chars:
                if not _bad_cut(cur, p) or self._len(cur) + self._len(p) > ceil_chars:
                    out.append(cur)
                    cur = p
                else:
                    cur += p        # keep the stub / the continuation with what it belongs to
            else:
                cur = (cur + p) if cur else p
        if cur:
            out.append(cur)
        # any single clause still too long stays (rare)
        return out

    def _split_structured(self, s: str) -> list[str]:
        m = _COLON.match(s.strip())
        if not m:
            return [s]
        head, tail = m.group(1).rstrip("，,、"), m.group(2).strip()
        if len(_ARROWISH.findall(tail)) < 2:
            return [s]  # k:v lines and 、-enumerations are read whole by the planner (table / radial)
        if self._len(head) < self.min_chars or self._len(tail) > self.max_chars:
            return [s]
        return [head, tail]

    def segment(self, text: str) -> list[str]:
        from .markdown import normalize

        raw: list[tuple[str, bool]] = []
        for line in normalize(text).splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            # A line with no word in it has nothing for the voice to read — `---`, `***`, a
            # stray `~~~`. One such beat failed an entire job at rc=1, so it never becomes one.
            if not _WORD.search(stripped):
                continue
            # a line that started with a list/header marker is a deliberate item — it must
            # stay its own beat even when short (otherwise stripping the marker would let
            # "设计系统" fall under min_chars and merge into a run-on).
            protected = bool(_LIST_MARK.match(stripped))
            line = _strip_md(_LIST_MARK.sub("", stripped, count=1))
            if not line:
                continue
            sentences = [s.strip() for s in _SENT_SPLIT.split(line) if s and s.strip()]
            for sent in sentences:
                for part in self._split_structured(sent):
                    raw.extend((b, protected) for b in self._split_long(part))
        beats = self._merge_tiny(raw)
        if self.hard_cap is not None and len(beats) > self.hard_cap:
            raise ValueError(
                f"{len(beats)} beats from {len(text)} chars exceeds the hard cap {self.hard_cap} "
                f"(≈{len(beats) * SECONDS_PER_BEAT / 60:.1f} min of narration); "
                f"split the script into separate jobs")
        return beats

    def _join(self, a: str, b: str) -> str:
        """Concatenate two beats. Latin runs need a space between them; CJK does not
        (CJK chars are non-ASCII, so an ASCII boundary on both sides means latin)."""
        if a and b and a[-1].isascii() and not a[-1].isspace() and b[0].isascii() and not b[0].isspace():
            return a + " " + b
        return a + b

    def _merge_tiny(self, raw: list[tuple[str, bool]]) -> list[str]:
        """Fold a sub-min_chars fragment into its neighbour — but never touch a protected
        (explicit list/header) beat, and never merge across a protected boundary."""
        out: list[list] = []  # [text, protected]
        for text, prot in raw:
            mergeable = out and not prot and not out[-1][1] and (
                self._len(out[-1][0]) < self.min_chars
                or (self._len(text) < self.min_chars
                    and self._len(out[-1][0]) + self._len(text) <= self.max_chars + self.min_chars))
            if mergeable:
                out[-1][0] = self._join(out[-1][0], text)
            else:
                out.append([text, prot])
        # trailing fragment (only if both it and the previous are unprotected)
        if len(out) >= 2 and not out[-1][1] and not out[-2][1] and self._len(out[-1][0]) < self.min_chars:
            out[-2][0] = self._join(out[-2][0], out[-1][0])
            out.pop()
        return [t for t, _ in out]


def segment_text(text: str, **kw: object) -> list[str]:
    return SentenceSegmenter(**kw).segment(text)  # type: ignore[arg-type]
