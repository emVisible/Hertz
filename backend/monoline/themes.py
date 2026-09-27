"""Theme registry (V2) — resolve a design-token file + brand/accent overrides.

Themes live in design/tokens/*.json. A job's config picks one by id and may
override the accent color; accent_ink is derived by luminance so text on the
accent stays legible. Monochrome stays structural — this only swaps palettes.
"""
from __future__ import annotations

import json
from pathlib import Path

from .sceneplan import Theme

DEFAULT_THEME = "mono-ink"

# Hertz 移植：tokens 随包发布（backend/monoline/tokens/），不再经 monoline settings
# 的 repo 相对路径解析（原 `settings.design_tokens_dir`）。
TOKENS_DIR = Path(__file__).parent / "tokens"


def available() -> list[dict]:
    out = []
    for f in sorted(TOKENS_DIR.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if f.name == "ui.json" or "tokens" not in d:
            continue
        c = d["tokens"].get("color", {})
        out.append({"id": d.get("id", f.stem), "label": d.get("label", f.stem),
                    "mode": d.get("mode", "dark"), "accent": c.get("accent"),
                    "paper": c.get("paper"), "ink": c.get("ink")})
    return out


def _lum(hex_color: str) -> float:
    h = (hex_color or "").lstrip("#")
    if len(h) != 6:
        return 0.0
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def resolve(config: dict) -> Theme:
    theme_id = config.get("theme") or DEFAULT_THEME
    path = TOKENS_DIR / f"{theme_id}.json"
    if not path.exists():
        path = TOKENS_DIR / f"{DEFAULT_THEME}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    tokens = data.get("tokens", {})
    accent = config.get("accent")
    if accent:
        colors = tokens.setdefault("color", {})
        colors["accent"] = accent
        colors["accent_ink"] = "#0B0B0C" if _lum(accent) > 0.55 else "#FFFFFF"
    return Theme(**(data | {"id": data.get("id", path.stem)}))
