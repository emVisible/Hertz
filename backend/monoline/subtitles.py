"""Subtitle sidecars — deterministic SRT/VTT from the beat timings.

Each segment already carries start/end (seconds, set during assemble) and text, so
export is pure string formatting: no re-TTS, no timing drift. Kept free of I/O so it
is unit-testable without the pipeline.
"""
from __future__ import annotations

from collections.abc import Sequence

from .display_text import detonate


def _ts(seconds: float, *, comma: bool) -> str:
    """Seconds → HH:MM:SS,mmm (SRT) or HH:MM:SS.mmm (VTT)."""
    ms = max(0, int(round(seconds * 1000)))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    sep = "," if comma else "."
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _cues(segments: Sequence[dict]) -> list[tuple[int, float, float, str]]:
    out = []
    for _n, seg in enumerate(segments, start=1):
        # same policy as the slide: no punctuation in the caption track either, replaced by a
        # space so a two-clause line never welds into one word
        text = detonate(seg.get("text"))
        if not text:
            continue
        start = float(seg.get("start") or 0.0)
        end = float(seg.get("end") or 0.0)
        if end <= start:  # guard against a zero/negative span from a stub timing
            end = start + 1.0
        out.append((len(out) + 1, start, end, text))
    return out


def to_srt(segments: Sequence[dict]) -> str:
    blocks = [
        f"{idx}\n{_ts(a, comma=True)} --> {_ts(b, comma=True)}\n{text}"
        for idx, a, b, text in _cues(segments)
    ]
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def to_vtt(segments: Sequence[dict]) -> str:
    lines = ["WEBVTT", ""]
    for idx, a, b, text in _cues(segments):
        lines.append(f"{idx}\n{_ts(a, comma=False)} --> {_ts(b, comma=False)}\n{text}\n")
    return "\n".join(lines)
