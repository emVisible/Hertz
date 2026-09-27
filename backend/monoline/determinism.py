"""Fail-closed determinism + correctness assertions on generated composition HTML.

The renderer is a clean headless Chrome with no network and no installed fonts.
Any of these in the output is a build bug, not a warning — they cause
non-reproducible pixels or silent failures (e.g. an id-less <audio> renders SILENT).
"""
from __future__ import annotations

import re

# (pattern, human message)
FORBIDDEN: list[tuple[str, str]] = [
    # Remote RESOURCE references only. A URL in display text is harmless (autoescape
    # prevents it becoming a live tag) and must not fail a job — users paste links.
    (r"""(?:src|href|poster)\s*=\s*["']?\s*https?://""", "remote resource URL — compositions must be fully local/offline"),
    (r"url\(\s*[\"']?https?://", "remote url() in CSS — must be local/offline"),
    (r"@import\b", "@import — must inline local CSS"),
    (r"\bMath\.random\b", "unseeded randomness breaks determinism"),
    (r"\bDate\.now\b", "wall-clock breaks determinism"),
    (r"\bperformance\.now\b", "clock breaks determinism"),
    (r"\bcrossorigin\b", "crossorigin breaks media preview (unconditional lint error)"),
    (r"repeat:\s*-1", "infinite repeat (use a finite count)"),
]


class CompositionAssertionError(Exception):
    def __init__(self, problems: list[str]) -> None:
        self.problems = problems
        super().__init__("composition assertion failed:\n  - " + "\n  - ".join(problems))


def assert_determinism(html: str) -> None:
    problems: list[str] = []

    for pat, msg in FORBIDDEN:
        if re.search(pat, html):
            problems.append(f"{msg} (matched /{pat}/)")

    # every <audio> must carry an id, or the render is silent
    for tag in re.findall(r"<audio\b[^>]*>", html, flags=re.I):
        if not re.search(r"\bid\s*=", tag):
            problems.append("<audio> without id → render will be silent")

    # every <script> with a src must be local (no srcless + no remote already covered)
    for tag in re.findall(r"<script\b[^>]*\bsrc\s*=\s*[\"']([^\"']+)[\"'][^>]*>", html, flags=re.I):
        if tag.startswith("http") or tag.startswith("//"):
            problems.append(f"remote <script src>: {tag}")

    # timeline registry guard present (required when a timeline is registered)
    if re.search(r"window\.__timelines\[", html):
        compact = re.sub(r"\s+", "", html)
        if "window.__timelines=window.__timelines||{}" not in compact:
            problems.append("window.__timelines used without `window.__timelines = window.__timelines || {}` guard")

    if problems:
        raise CompositionAssertionError(problems)
