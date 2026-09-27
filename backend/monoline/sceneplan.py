"""sceneplan/v1 — the meaning layer. Replaces generate.py's hardcoded `stage` list.

Monochrome is enforced by the theme tokens and the templates (one accent colour per theme,
`--accent` used sparingly), **not** by a per-slot flag: an earlier draft of this file let
slots carry a `tone` ∈ {ink, muted, accent} and validated "≤1 accent per scene", but nothing
in the planner ever wrote a tone, so that check could not fire. Removed rather than kept as
a promise the code does not keep.
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA = "sceneplan/v1"

# Full M2 kind registry. Each kind = one Jinja partial + a slot spec in kinds.json.
# `statement` is the safe default. V27 adds the diagram kinds (`flow` / `radial` /
# `steps`) built from the shared `.node` graphic atom — content that renders as a
# picture (nodes + connectors) instead of a line of text.
KINDS = ["title", "statement", "section", "definition", "stat", "table",
         "cards", "compare", "quote", "list", "note", "summary", "image",
         "flow", "radial", "steps", "arch", "cycle", "funnel", "bars",
         "kpi", "timeline", "share", "trend", "matrix", "poster", "showcase", "split"]
# Kinds whose whole payload is already drawn as graphics on the slide — the caption
# would just repeat the node labels, so the planner marks them verbatim.
DIAGRAM_KINDS = {"flow", "radial", "steps", "arch", "cycle", "funnel"}
KINDS_M1 = set(KINDS)  # validate_against accepts the full set as of M2


class Canvas(BaseModel):
    width: int = 1920
    height: int = 1080
    fps: int = 30


class Theme(BaseModel):
    """Loaded from design/tokens/*.json — shared with the web UI."""

    id: str
    label: str = ""
    mode: Literal["dark", "light"] = "dark"
    tokens: dict[str, Any] = Field(default_factory=dict)

    @property
    def color(self) -> dict[str, str]:
        return self.tokens.get("color", {})

    @property
    def motion(self) -> dict[str, Any]:
        return self.tokens.get("motion", {})

    @property
    def space(self) -> dict[str, Any]:
        return self.tokens.get("space", {})


class Brand(BaseModel):
    label: str = "Monoline"
    logo: str = ""            # composition-relative image path (assets/…); empty = text-only brand


class Captions(BaseModel):
    # "auto_chunk" used to be listed here and never implemented: the template only tested
    # `!= "none"`, so it behaved exactly like "sentence". An option nobody can reach is a bug
    # waiting to be reported against a mode that does not exist.
    mode: Literal["sentence", "none"] = "sentence"


class Scene(BaseModel):
    model_config = ConfigDict(extra="allow")
    i: int
    kind: str
    source: str = "manual"  # rules:<pattern> | manual | llm — provenance badge in UI
    # Which part of the film this beat belongs to, filled by a whole-piece pass from the nearest
    # preceding `section` beat.  Carried per scene (not per divider) so the audience always knows
    # where they are, not only on the title card that announces it.
    section: str = ""
    slots: dict[str, Any] = Field(default_factory=dict)
    layout: dict[str, Any] | None = None
    motion: dict[str, Any] | None = None


def overlays_from_config(config: dict) -> dict:
    """The two corner overlays a job carries, derived from its config in ONE place.

    The runner builds a `ScenePlan` object while retheme patches the stored JSON dict, and each
    used to spell out `config.get("brand", "Monoline")` on its own — which is how `folio` would
    have been added to one path and forgotten in the other.  An empty `brand` is a user choice,
    so only a MISSING key takes the default; `folio` defaults to on.
    """
    return {"brand": {"label": config.get("brand", "Monoline"), "logo": config.get("logo", "")},
            "folio": bool(config.get("folio", True)),
            "sections": bool(config.get("sections", True))}


class ScenePlan(BaseModel):
    schema_: str = SCHEMA
    job_id: str = ""
    canvas: Canvas = Field(default_factory=Canvas)
    theme: Theme
    brand: Brand = Field(default_factory=Brand)
    captions: Captions = Field(default_factory=Captions)
    # The page number in the corner ("07 / 24").  A deck-style affordance, so it is a
    # preference, not a fact — an empty brand works the same way: `Brand(label="")` means
    # "no wordmark", which is different from the field never being set.
    folio: bool = True
    # The running "current section" head.  Optional by toggle, and optional by absence: a film
    # with no `section` beat paints nothing, so turning this on cannot regress an existing job.
    sections: bool = True
    scenes: list[Scene] = Field(default_factory=list)

    def validate_against(self, n_segments: int) -> list[str]:
        """Return warnings (non-blocking); raises on hard violations."""
        warnings: list[str] = []
        if len(self.scenes) != n_segments:
            raise ValueError(
                f"scene count ({len(self.scenes)}) != segment count ({n_segments})"
            )
        for n, s in enumerate(self.scenes):
            if s.kind not in KINDS_M1:
                warnings.append(f"scene {s.i}: kind '{s.kind}' not in M1 set {sorted(KINDS_M1)}")
            # `self.scenes.index(s)` was the original test — list.index() returns the position of
            # the first *equal* element, not this element's position, so it could not tell a
            # reordered plan from a duplicate one.
            if s.i != n:
                warnings.append(f"scene index {s.i} out of order (position {n})")
        return warnings
