"""API 清单双向比对（Phase 4.1 地基回哺：monoline CONFIG.md 测试思想）。

docs/API_INVENTORY.md 的反引号行集合必须与 app.openapi() 完全一致——
任一方向差集都失败。改路由后跑 `uv run python scripts/api_inventory.py` 同步。
"""

import re

from backend.main import app

DOC = "docs/API_INVENTORY.md"
_PATTERN = re.compile(r"`((?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+)`")


def _documented() -> set[str]:
    text = open(DOC, encoding="utf-8").read()
    return set(_PATTERN.findall(text))


def _live() -> set[str]:
    spec = app.openapi()
    out = set()
    for path in sorted(spec.get("paths", {})):
        for method in sorted(spec["paths"][path]):
            out.add(f"{method.upper()} {path}")
    return out


def test_api_surface_matches_in_both_directions() -> None:
    doc, live = _documented(), _live()
    ghost = sorted(doc - live)
    missing = sorted(live - doc)
    assert not ghost, f"文档有、应用无（ghost）：{ghost[:10]}"
    assert not missing, f"应用有、文档无（missing）：{missing[:10]}"


def test_monoline_domain_present() -> None:
    live = _live()
    mono = sorted(p for p in live if p.startswith(("GET /api/monoline", "POST /api/monoline",
                                                   "PATCH /api/monoline", "DELETE /api/monoline")))
    assert len(mono) >= 15, mono
