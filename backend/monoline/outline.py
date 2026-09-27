"""大纲：整片的可编辑清单，在付音频成本之前审阅（移植自 monoline `pipeline/outline.py`）。

Hertz 适配：`repo/settings` 形参改为 `store`（MonolineStore）+ 工作区根目录；
`themes.resolve(settings, config)` 改为 `resolve(config)`（随包 tokens）。
`build()` 读侧：切分 + 分镜，不出音频。`apply()` 写侧：用户清单落盘 `source="manual"`。
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from .planner import RulePlanner, apply_icons, number_sections
from .rotation import label_sections
from .sceneplan import KINDS, Canvas, ScenePlan, overlays_from_config
from .segment import HARD_CAP, segment_text
from .store import MonolineStore
from .themes import resolve as resolve_theme
from .workspace import Workspace

# Every one of these templates falls back to `seg.text` when its slot is empty, so pinning one
# can never paint a hole.
_TEXT_KINDS = {"title", "statement", "section", "definition", "quote", "note", "summary",
               "split", "poster"}
# Rough Mandarin rate, measured off this project's own narration: ~4.3 chars/second plus a
# breath per beat. Good enough to plan a film with; the real number arrives with the TTS.
_CHARS_PER_SECOND = 4.3
_BREATH = 0.45


def _h(*parts: object) -> str:
    return hashlib.sha256("⋄".join(str(p) for p in parts).encode("utf-8")).hexdigest()[:16]


def _now():
    return datetime.now(UTC)


def estimate(text: str) -> float:
    n = len(re.sub(r"\s", "", str(text or "")))
    return round(max(1.2, n / _CHARS_PER_SECOND + _BREATH), 2)


def storyboard(beats: list[str], *, script: str, brand: str) -> list[dict]:
    """The rule storyboard for a list of beats — the same call the `plan` stage makes."""
    scenes = RulePlanner().plan(beats, brand=brand, script=script)
    apply_icons(scenes, beats)
    number_sections(scenes)
    return scenes


def _entries(segs: list[dict], scenes: list[dict]) -> list[dict]:
    labels = label_sections([dict(s) for s in scenes])
    out = []
    for i, seg in enumerate(segs):
        sc = scenes[i] if i < len(scenes) else {}
        label = labels[i].get("section", "") if i < len(labels) else ""
        slots = sc.get("slots") or {}
        pics = ([slots["image"]] if slots.get("image") else
                [r.get("img", "") for r in slots.get("rows") or []
                 if isinstance(r, dict) and r.get("img")])
        out.append({"i": i, "text": seg["text"], "kind": sc.get("kind", "statement"),
                    "source": sc.get("source", ""), "section": label,
                    "image": pics[0] if pics else "", "images": pics,
                    "seconds": estimate(seg["text"])})
    return out


def _view(entries: list[dict]) -> dict:
    from .llm_plan import WEAK_KINDS

    weak = sum(1 for e in entries if e.get("kind") in WEAK_KINDS)
    return {"entries": entries, "beats": len(entries),
            "est_seconds": round(sum(e["seconds"] for e in entries), 1),
            "sections": sorted({e["section"] for e in entries if e["section"]}),
            "weak_beats": weak}


async def store_plan(store: MonolineStore, ws_root: Path, job_id: UUID,
                     job: dict, config: dict, scenes: list[dict], *, source: str) -> int:
    """Save the storyboard AND claim the two stages it replaces (script + plan)."""
    canvas = Canvas(**(job.get("canvas") or {}))
    plan = ScenePlan(canvas=canvas, theme=resolve_theme(config).model_dump(),
                     scenes=scenes, **overlays_from_config(config))
    js = plan.model_dump_json()
    version = await store.save_plan(job_id, js, source, [])

    script = job.get("script_text") or ""
    ws = Workspace(ws_root).ensure()
    (ws.ir / "scene_plan.json").write_text(js, encoding="utf-8")
    await store.upsert_stage(job_id, "script", 0, status="succeeded",
                             finished_at=_now(), input_hash=_h(script))
    await store.upsert_stage(job_id, "plan", 3, status="succeeded", finished_at=_now(),
                             input_hash=_h(script, config.get("brand"), config.get("theme"),
                                           config.get("accent")))
    return version


async def build(store: MonolineStore, ws_root: Path, job_id: UUID) -> dict:
    """Segment + storyboard the job (no audio), persist both, return the outline."""
    job = await store.get_job(job_id)
    if not job:
        raise KeyError(str(job_id))
    config = job.get("config") or {}
    script = job.get("script_text") or ""
    beats = segment_text(script)
    if not beats:
        raise ValueError("script is empty")
    if len(beats) > HARD_CAP:
        raise ValueError(f"{len(beats)} beats exceeds the cap {HARD_CAP}")

    await store.replace_segments(job_id, [{"i": i, "text": t, "line_no": i + 1}
                                          for i, t in enumerate(beats)])
    scenes = storyboard(beats, script=script, brand=config.get("brand", "Monoline"))
    await store_plan(store, ws_root, job_id, job, config, scenes, source="rules")
    return _view(_entries(await store.get_segments(job_id), scenes))


async def current(store: MonolineStore, job_id: UUID) -> dict:
    """The outline as it stands now, from whatever is already stored — no re-segmenting."""
    job = await store.get_job(job_id)
    if not job:
        raise KeyError(str(job_id))
    segs = await store.get_segments(job_id)
    row = await store.get_plan(job_id)
    plan = row["plan_json"] if row else {}
    scenes = plan.get("scenes", []) if isinstance(plan, dict) else []
    if len(scenes) != len(segs):
        config = job.get("config") or {}
        scenes = storyboard([s["text"] for s in segs], script=job.get("script_text") or "",
                            brand=config.get("brand", "Monoline"))
    return _view(_entries(segs, scenes))


# The asset path a beat may be pointed at. `POST /assets` mints exactly this shape
# (`assets/<sha1-16>.<ext>`), so anything else — including a traversal — is refused.
_ASSET = re.compile(r"^assets/[0-9a-f]{16}\.(?:png|jpe?g|webp|gif)$")


async def apply(store: MonolineStore, ws_root: Path, job_id: UUID, edits: list[dict]) -> dict:
    """Take the user's list — their order, their text — and make it the job."""
    job = await store.get_job(job_id)
    if not job:
        raise KeyError(str(job_id))
    config = job.get("config") or {}

    beats: list[str] = []
    wanted: list[tuple[str, list[str]]] = []
    for e in edits:
        text = re.sub(r"\s+", " ", str(e.get("text") or "")).strip()
        if not text:
            continue
        beats.append(text)
        pics = [str(x) for x in (e.get("images") or ([str(e["image"])] if e.get("image") else []))]
        wanted.append((str(e.get("kind") or ""), pics))
    if not beats:
        raise ValueError("大纲是空的：至少留一拍")
    if len(beats) > HARD_CAP:
        raise ValueError(f"{len(beats)} beats exceeds the cap {HARD_CAP}")

    await store.replace_segments(job_id, [{"i": i, "text": t, "line_no": i + 1}
                                          for i, t in enumerate(beats)])
    scenes = storyboard(beats, script=job.get("script_text") or "",
                        brand=config.get("brand", "Monoline"))
    comp = Workspace(ws_root).composition

    def checked(img: str) -> str:
        if not _ASSET.match(img) or not (comp / img).exists():
            raise ValueError(f"这一拍的图片不可用：{img[:40]}")
        return img

    pinned = images = 0
    for sc, (want, pics) in zip(scenes, wanted, strict=True):
        slots = sc.setdefault("slots", {})
        if want == "image" and pics:
            slots["image"] = checked(pics[0])
            slots["verbatim"] = True
            sc["kind"], sc["source"] = "image", "manual:outline"
            images += 1
        elif want == "showcase" and pics:
            if len(pics) < 2:
                raise ValueError("组图至少要两张图；只有一张请用「图」这一类")
            slots["rows"] = [{"img": checked(p), "k": "", "v": ""} for p in pics[:4]]
            slots["verbatim"] = True
            sc["kind"], sc["source"] = "showcase", "manual:outline"
            images += 1
        elif want and want in KINDS and want != sc["kind"] and want in _TEXT_KINDS:
            sc["kind"] = want
            sc["source"] = "manual:outline"
            pinned += 1
    version = await store_plan(store, ws_root, job_id, job, config, scenes, source="manual")
    return {**_view(_entries(await store.get_segments(job_id), scenes)),
            "pinned": pinned, "imaged": images, "version": version}
