"""LLM 分镜升级（移植自上游 `llm/planner.py`，V29 语义保留）。

规则拥有结构，模型只升格 rules 无能为力的纯文字拍；回答必须 well-formed +
grounded（逐字来自该拍）否则丢弃。统计 declined/bad_kind/bad_slots 三分法保留
（"模型认为保持纯文字"是 verdict 不是失败）。

Hertz 适配：上游 `llm/client.py`（环境探测 + 直调 /chat/completions）删除，
改为 TaskRouter（D-022）：调用方传入 `ai` + `model` 名；超时经 asyncio.wait_for；
suggest 缓存改 `data_dir/cache/suggest`（file_store）。

上游设计注记（V29 实测）：全量规划在本地小模型上 83s 回 5/6 拍且打碎槽形，
故只问弱拍；prompt 用字面 JSON 骨架而非散文描述（4B 模型按散文会漏槽）。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path

from .display_text import tidy_slots


def list_as(value: object) -> list | None:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        scenes = value.get("scenes")
        return scenes if isinstance(scenes, list) else None
    return None


_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def parse_json(text: str) -> object:
    text = (text or "").strip()
    m = _JSON_BLOCK_RE.search(text)
    if m:
        text = m.group(1).strip()
    return json.loads(text)


async def _chat_json(ai, messages: list[dict], *, timeout_s: float) -> object:
    """经 TaskRouter 取 JSON（temperature 0 求稳；代码块宽容解析）。"""
    from backend.ai.types import ChatMessage

    text = await asyncio.wait_for(
        ai.chat_messages([ChatMessage(**m) for m in messages],
                         temperature=0.0, max_tokens=2048, caller="monoline-llm"),
        timeout=timeout_s,
    )
    return parse_json(text)

# What the model may promote a plain sentence INTO. Deliberately excludes title /
# summary / section (positional), note (rules own caveats) and image (needs an upload).
ALLOWED: dict[str, dict[str, str]] = {
    "stat": {"value": "s", "label": "s"},
    "definition": {"term": "s", "gloss": "s"},
    "quote": {"q": "s"},
    "list": {"items": "sl"},
    "table": {"rows": "kv"},
    "bars": {"title": "s", "rows": "kv"},
    "kpi": {"title": "s", "rows": "kv"},
    "timeline": {"title": "s", "rows": "kv"},
    "share": {"title": "s", "rows": "kv"},
    "trend": {"title": "s", "series": "sl"},
    "matrix": {"title": "s", "x_axis": "s", "y_axis": "s", "cells": "sl"},
    "cards": {"title": "s", "rows": "kv"},
    "compare": {"a": "pair", "b": "pair"},
    "flow": {"nodes": "sl"},
    "radial": {"hub": "s", "nodes": "sl"},
    "steps": {"steps": "sl"},
}

_MAX_STR, _MIN_ITEMS, _MAX_ITEMS = 24, 2, 5
# A local model gets both worse and heavier with a long list: it returns fewer items than
# asked (breaking 1 beat = 1 scene) and a big prompt is what pushes the host out of memory.
# So the weak beats go up in sequential batches under both budgets.
BATCH_BEATS = 3
BATCH_CHARS = 900
# Measured on the local 7.5B q4 model: ~1 character/second of decode, so one beat with a real
# answer costs ~70s.  The upgrade pass gets a wall-clock budget instead of a beat count, because
# at this speed "ask about all 22 weak beats" is 25 minutes of dead waiting.
PLAN_BUDGET_SECONDS = 150
# Part of every per-beat suggestion cache key: bump it whenever the prompt or the slot rules
# change, and every stale verdict falls out without a migration.
SUGGEST_SCHEMA = "v3"
# Beats whose rule verdict is "just text" — the only ones worth asking about.
WEAK_KINDS = {"statement"}
_PUNCT = re.compile(r"[\s，,。.、：:；;！!？?“”\"'『」（）()《》\-—→…·*_#>❶-❿]")
# A slot that ends on a copula/particle is the sentence cut in half ("…的核心是"), which
# reads as a bug on screen even though every character is faithfully from the beat.
_DANGLING = re.compile(r"[是为指把将而且的和在与就都很这那的了着吗呢啊吧]$")

# Slot types described as the literal JSON the model must produce. Describing them in prose
# ("rows=k:v对象数组") was measured to be the failure: a 4B model returns `cards` with only
# `title` filled because nothing in the prompt shows that `rows` exists next to it.
_SHAPE = {"s": '"…"', "sl": '["…", "…"]', "kv": '[{"k": "…", "v": "…"}]',
          "pair": '{"h": "…", "d": "…"}'}
# A few slots are not "any text" even though the skeleton says so, and a 4B model cannot infer
# that from a key name.  Measured: of 5 plain-text Chinese beats the model redesigned, 2 died at
# `stat` with a whole clause in `value` ("不是这一拍里的连续文字" / "27 个显示单元 > 24") — the
# guard was right, the prompt was silent.  These hints cost ~5 characters each; the prompt is
# already 1141 chars on a machine where prompt length is the expensive part (see the budget test).
_HINT: dict[tuple[str, str], str] = {
    ("stat", "value"): '"数字，≤8字"',
    ("definition", "term"): '"词，≤6字"',
    ("quote", "q"): '"原文短句"',
}

_SPEC_LINES = "\n".join(
    f'{k}: {{' + ", ".join(f'"{name}": {_HINT.get((k, name), _SHAPE[t])}'
                           for name, t in spec.items()) + '}'
    for k, spec in ALLOWED.items()
)


def build_prompt(items: list[tuple[int, str]]) -> list[dict]:
    sys = (
        "你是短视频的分镜判定器。给你若干「拍」（一句口播，中文或英文），逐拍判断它最适合画成什么，"
        "并抽取画面要用的文字。英文拍同样要判定，不要因为语言是英文就一律回答 statement。\n"
        f"可选类型与槽位：\n{_SPEC_LINES}\n"
        "硬性要求：\n"
        # json_object mode wants ONE top-level object — asking for a bare array makes
        # Ollama emit a single item and stop, which reads as "everything rejected".
        "1) 只输出一个 JSON 对象：{\"scenes\":[{\"i\":序号,\"kind\":类型,\"slots\":{…}}, …]}，不要解释、不要代码块；\n"
        "2) scenes 数组长度等于拍数，序号照抄；\n"
        "3) slots 必须把该类型上面那一行的每个键都填上，缺任何一个键该条即作废；\n"
        "4) 槽位里的每个字都必须原样来自该拍（可截取，不可改写、不可新增）；\n"
        f"5) 每个字符串不超过 {_MAX_STR} 个显示单元（≈{_MAX_STR} 个汉字 = ≈{_MAX_STR * 2} 个英文字母"
        f" ≈ {max(1, _MAX_STR // 3)} 个英文单词）；数组类槽位 {_MIN_ITEMS}-{_MAX_ITEMS} 项；\n"
        "6) 如果某拍确实不适合上面任何类型，输出 {\"i\":序号,\"kind\":\"statement\",\"slots\":{}}。"
    )
    user = "\n".join(f"{i}. {text}" for i, text in items)
    return [{"role": "system", "content": sys}, {"role": "user", "content": user}]


def _norm(s: str) -> str:
    return _PUNCT.sub("", s or "")


def _width(s: str) -> float:
    """Display units, not characters: a CJK glyph is one, a latin glyph about half.

    The cap is a slide-fit rule, and `len()` measured it in characters — so a 24-unit budget
    allowed 24 Chinese characters but only ~12 English words' worth of *text*, while the prompt
    said 「不超过 24 字」 and a model reading English counts 字 as **words**. Measured on an
    English script: the model's single non-statement verdict was a 51-char quote, rejected as
    "too long" when it is 25.5 units — the two sides were not using the same ruler.
    """
    return sum(1.0 if "一" <= c <= "鿿" else 0.5 for c in s)


def _reject(value: str, beat: str) -> str:
    """'' when the value may go on screen, otherwise the reason it may not.  Returning a
    reason instead of a bool is what makes a rejection readable in the workflow log — the
    same counter used to cover 「the model invented text」 and 「the model cut the sentence in
    half」 under one message, which cost a whole debugging round."""
    v, b = _norm(value), _norm(beat)
    if not v:
        return "空值"
    if _width(v) > _MAX_STR:
        return f"超长（{_width(v):.0f} 个显示单元 > {_MAX_STR}）"
    if v not in b:
        return "不是这一拍里的连续文字"
    if _DANGLING.search(v):
        return f"停在读点上（「…{value.strip()[-6:]}」）"
    return ""


def _grounded(value: str, beat: str) -> bool:
    """Reject invented copy — a small model will happily write a nicer phrase — and a
    value that ends mid-sentence, which is grounded but reads as a truncation bug."""
    return not _reject(value, beat)


def _clean_slots(kind: str, slots: object, beat: str) -> tuple[dict | None, str]:
    """Validate + normalize one verdict. (None, why) = unusable, keep the rule's answer."""
    if not isinstance(slots, dict):
        return None, "slots 不是对象"
    out: dict = {}
    for name, typ in ALLOWED[kind].items():
        raw = slots.get(name)
        if raw is None:
            return None, f"缺槽位 {name}（要 {'/'.join(ALLOWED[kind])}）"
        if typ == "s":
            val = str(raw or "").strip()
            why = _reject(val, beat)
            if why:
                return None, f"{name}「{val[:14]}」{why}"
            out[name] = val
        elif typ == "sl":
            items = [str(x).strip() for x in (list_as(raw) or []) if str(x).strip()]
            if not (_MIN_ITEMS <= len(items) <= _MAX_ITEMS):
                return None, f"{name} 要 {_MIN_ITEMS}-{_MAX_ITEMS} 项，给了 {len(items)}"
            for x in items:
                why = _reject(x, beat)
                if why:
                    return None, f"{name}「{x[:14]}」{why}"
            out[name] = items[:_MAX_ITEMS]
        elif typ == "kv":
            rows = []
            for r in list_as(raw) or []:
                if not isinstance(r, dict):
                    return None, f"{name} 不是对象数组"
                k, v = str(r.get("k", "")).strip(), str(r.get("v", "")).strip()
                for key, val in (("k", k), ("v", v)):
                    why = _reject(val, beat)
                    if why:
                        return None, f"{name}.{key}「{val[:14]}」{why}"
                rows.append({"k": k, "v": v})
            if not (_MIN_ITEMS <= len(rows) <= _MAX_ITEMS):
                return None, f"{name} 要 {_MIN_ITEMS}-{_MAX_ITEMS} 行，给了 {len(rows)}"
            out[name] = rows
        elif typ == "pair":
            if not isinstance(raw, dict):
                return None, f"{name} 不是对象"
            for key in ("h", "d"):
                val = str(raw.get(key, "")).strip()
                why = _reject(val, beat)
                if why:
                    return None, f"{name}.{key}「{val[:14]}」{why}"
            out[name] = {"h": str(raw["h"]).strip(), "d": str(raw["d"]).strip()}
    return out, ""


def merge(beats: list[str], scenes: list[dict], payload: object, *, force: bool = False) -> tuple[list[dict], dict]:
    """Fold validated model verdicts into the rule plan. Never changes the scene count.

    `force` asks about beats the rules already gave a shape to — used by the per-beat
    "换个形状" request in Studio, where the user explicitly wants a second opinion.

    `rejected` used to cover three different facts, which is how a working feature looked
    broken: measured on a real 15-beat script, 4 runs all reported `upgraded=0 rejected=15`,
    and 13 of those 15 were the model correctly saying "this one stays plain text". Now the
    three are counted apart — `declined` (the model agrees with the rules: a verdict, not a
    failure), `bad_kind` (it named a type we never offered) and `bad_slots` (it named one it
    could not fill — e.g. `cards` with a title and no rows, which is what the 4B model does
    most often). `why` carries one example so the number can be read without re-running.
    """
    stats = {"asked": 0, "upgraded": 0, "declined": 0, "missing": 0, "bad_kind": 0, "bad_slots": 0}
    by_index = {}
    for item in list_as(payload):
        if isinstance(item, dict) and isinstance(item.get("i"), int):
            by_index[item["i"]] = item
    out = list(scenes)
    for i, beat in enumerate(beats):
        if not force and out[i]["kind"] not in WEAK_KINDS:
            continue
        stats["asked"] += 1
        verdict = by_index.get(i)
        if verdict is None:
            # A dropped batch looks exactly like "the model refused every beat" unless this is
            # counted apart — measured: 2 timed-out batches read as bad_kind=22.
            stats["missing"] += 1
            continue
        kind = verdict.get("kind")
        if kind == out[i]["kind"]:                  # "leave it as text" is an answer
            stats["declined"] += 1
            continue
        if kind not in ALLOWED:
            stats["bad_kind"] += 1
            stats.setdefault("why", []).append(f"#{i} kind={kind!r} 不在候选类型里")
            continue
        slots, why = _clean_slots(kind, verdict.get("slots"), beat)
        if slots is None:
            stats["bad_slots"] += 1
            stats.setdefault("why", []).append(f"#{i} {kind}: {why}")
            continue
        out[i] = {"i": i, "kind": kind, "source": "llm:upgrade",
                  "slots": tidy_slots(kind, slots)}
        stats["upgraded"] += 1
    if isinstance(stats.get("why"), list):
        stats["why"] = stats["why"][:3]
    stats["rejected"] = stats["bad_kind"] + stats["bad_slots"]
    return out, stats


def _suggest_cache_dir() -> Path:
    from backend.infrastructure.storage import file_store

    return file_store.data_dir / "cache" / "suggest"


async def suggest(ai, beat: str, scene: dict, *, model: str,
                  timeout_s: float = 240.0, use_cache: bool = True) -> dict:
    """One beat's second opinion, cached by (prompt schema, model, beat text).

    `SUGGEST_SCHEMA` 进缓存键：改 prompt 即失活旧 verdict，无需迁移；失败请求永不缓存。
    四种结局具名：changed / kept / rejected / unanswered。
    """
    key = hashlib.sha1(f"{SUGGEST_SCHEMA}|{model}|{beat}".encode()).hexdigest()[:24]
    path = _suggest_cache_dir() / f"{key}.json"
    if use_cache and path.exists():
        try:
            return {**json.loads(path.read_text(encoding="utf-8")), "cached": True}
        except (OSError, json.JSONDecodeError):
            pass
    out, stats = await upgrade(ai, [beat], [dict(scene)], model=model,
                               timeout_s=timeout_s, force=True)
    cand = out[0]
    if stats.get("upgraded"):
        status = "changed"
    elif stats.get("declined"):
        status = "kept"
    elif stats.get("bad_kind") or stats.get("bad_slots"):
        status = "rejected"          # it answered, and our own guard refused the answer
    else:
        status = "unanswered"        # never reached the model / died on the way back
    verdict = {"status": status,
               "kind": cand.get("kind") if status == "changed" else None,
               "slots": cand.get("slots") if status == "changed" else None,
               "model": stats.get("model"), "seconds": stats.get("seconds"),
               "why": stats.get("why") or [],
               "error": (stats.get("error") or "模型没有回答这一拍（超时或响应被截断）")
                        if status == "unanswered" else "",
               "cached": False}
    if use_cache and status != "unanswered" and not stats.get("failed_batches"):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(verdict, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    return verdict


def _batches(items: list[tuple[int, str]], *, beats: int = BATCH_BEATS,
             chars: int = BATCH_CHARS) -> list[list[tuple[int, str]]]:
    """Group weak beats into requests under BOTH budgets, preserving order. A single beat
    longer than the char budget still gets its own batch (never dropped)."""
    out: list[list[tuple[int, str]]] = []
    cur: list[tuple[int, str]] = []
    used = 0
    for item in items:
        if cur and (len(cur) >= beats or used + len(item[1]) > chars):
            out.append(cur)
            cur, used = [], 0
        cur.append(item)
        used += len(item[1])
    if cur:
        out.append(cur)
    return out


async def upgrade(ai, beats: list[str], scenes: list[dict], *, model: str,
                  timeout_s: float = 240.0, force: bool = False,
                  batch_beats: int = BATCH_BEATS, batch_chars: int = BATCH_CHARS,
                  budget_seconds: float = PLAN_BUDGET_SECONDS) -> tuple[list[dict], dict]:
    """Ask the model about the weak beats. Returns (scenes, stats); never raises.

    Wall-clock 是硬约束：本地小模型解码慢，一次全量问完不现实，故按预算提前收手——
    没问到的拍保留规则分镜，计入 `skipped_batches` 而不是静默超时。
    """
    idx = [(i, beats[i]) for i in range(len(beats)) if force or scenes[i]["kind"] in WEAK_KINDS]
    if not idx:
        return scenes, {"asked": 0, "upgraded": 0, "rejected": 0, "skipped": "no weak beats",
                        "model": model}
    batches = _batches(idx, beats=max(1, int(batch_beats or 1)),
                       chars=max(60, int(batch_chars or 0)))
    budget = max(0.0, float(budget_seconds or 0))
    rows: list[dict] = []
    failed: list[str] = []
    skipped = 0
    t0 = time.monotonic()
    for n, b in enumerate(batches):
        if time.monotonic() - t0 > budget:
            skipped = len(batches) - n
            break
        try:
            rows.extend(list_as(await _chat_json(ai, build_prompt(b), timeout_s=timeout_s)) or [])
        except Exception as e:  # noqa: BLE001 — 坏一批只赔该批的拍，其余升级保留
            failed.append(str(e)[:120])
    out, stats = merge(beats, scenes, rows, force=force)
    stats.update({"model": model, "batches": len(batches), "asked_batches": len(batches) - skipped,
                  "failed_batches": len(failed), "skipped_batches": skipped,
                  "seconds": round(time.monotonic() - t0, 1)})
    if failed:
        stats["error"] = failed[0]
    return out, stats
