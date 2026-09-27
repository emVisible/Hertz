"""timings/v2 — the audio-derived timeline. Durations are NEVER stored, only
derived from end-start, so the PoC's `dur != end-start` drift bug is impossible.
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, field_validator

SCHEMA = "timings/v2"


class Segment(BaseModel):
    model_config = ConfigDict(frozen=True)
    i: int  # 0-based, aligns with sceneplan scenes
    start: float
    end: float
    text: str

    @property
    def dur(self) -> float:
        return round(self.end - self.start, 3)

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v, info):
        if v < info.data.get("start", 0):
            raise ValueError("segment end must be >= start")
        return v


class Timings(BaseModel):
    schema_: str = SCHEMA
    total: float
    segments: list[Segment]

    @classmethod
    def from_durations(cls, texts: list[str], durs: list[float]) -> Timings:
        """Tile the timeline from per-sentence durations (running sum)."""
        assert len(texts) == len(durs), "texts/durs length mismatch"
        segs: list[Segment] = []
        t = 0.0
        for i, (txt, d) in enumerate(zip(texts, durs, strict=True)):
            start = round(t, 3)
            end = round(t + float(d), 3)
            segs.append(Segment(i=i, start=start, end=end, text=txt))
            t = end  # accumulate from rounded end so segments tile with no gap
        return cls(total=round(t, 3), segments=segs)
