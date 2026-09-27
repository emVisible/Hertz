"""Font subsetting — deterministic, OFL-only, cached by glyph set.

Design (from the plan):
- Glyph set comes from an EXPLICIT allowlist (segment text ∪ scene slots ∪ brand
  ∪ ASCII ∪ common CJK punctuation), NEVER by scanning emitted HTML (fragile +
  size bomb).
- Source is the vendored OFL Noto Sans SC variable font, instantiated to a
  static weight (default 500) so headless Chrome renders a real Medium, not the
  VF's Thin default.
- Output cached by sha256(glyphset) so a multi-video series reuses one file.
"""
from __future__ import annotations

import hashlib
import string
from dataclasses import dataclass, field
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

# Punctuation we may show that isn't in ASCII and must be in the subset.
EXTRA_PUNCT = "、。！？：；·—…“”‘’（）《》【】↓↑×≈≥≤→"


def default_glyph_source() -> Path:
    # Hertz 移植：字源随包发布（backend/monoline/vendor/fonts/）。
    return Path(__file__).resolve().parent / "vendor" / "fonts" / "NotoSansSC.ttf"


@dataclass
class SubsetResult:
    out_path: Path
    glyphs: int
    bytes: int
    missing: list[str] = field(default_factory=list)  # codepoints absent from source
    cached: bool = False


def collect_glyphs(texts: list[str], *, brand: str = "", extra: str = "") -> set[str]:
    """Build the allowlist from actual display strings (never from HTML)."""
    chars: set[str] = set(string.printable) - {"\x0b", "\x0c"}
    for t in texts:
        chars.update(t)
    chars.update(brand)
    chars.update(extra)
    chars.update(EXTRA_PUNCT)
    # drop control chars
    return {c for c in chars if c == " " or ord(c) >= 0x20}


def _glyphset_hash(glyphs: set[str]) -> str:
    joined = "".join(sorted(glyphs))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


def _source_cmap(src: Path) -> set[int]:
    f = TTFont(str(src), fontNumber=0, lazy=True)
    cmap = set()
    for table in f["cmap"].tables:
        cmap.update(table.cmap.keys())
    f.close()
    return cmap


def subset_font(
    glyphs: set[str],
    out_path: Path,
    *,
    cache_dir: Path | None = None,
    src: Path | None = None,
    weight: int = 500,
) -> SubsetResult:
    src = src or default_glyph_source()
    if not src.exists():
        raise FileNotFoundError(f"OFL CJK source font missing: {src} (run make fonts)")

    missing = [f"U+{ord(c):04X} {c!r}" for c in glyphs if ord(c) not in _source_cmap(src)]

    # Cache hit?
    cache_key = _glyphset_hash(glyphs)
    cached = (cache_dir / f"{cache_key}.woff2") if cache_dir else None
    if cached and cached.exists():
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(cached.read_bytes())
        return SubsetResult(out_path, len(glyphs), out_path.stat().st_size, missing, cached=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(sorted(glyphs))

    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.glyph_names = False
    opts.hinting = False
    opts.desubroutinize = True

    font = TTFont(str(src), fontNumber=0)
    # Pin the variable weight axis to a static instance, then subset.
    if "fvar" in font:
        instantiateVariableFont(font, {"wght": weight}, inplace=True)
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text=text)
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(str(out_path))
    n = len(glyphs)
    size = out_path.stat().st_size

    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
        if cached:
            cached.write_bytes(out_path.read_bytes())
    return SubsetResult(out_path, n, size, missing, cached=False)
