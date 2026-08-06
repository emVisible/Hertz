"""Canvas NLP endpoints: 词性分析 + 灵感重组。

对画布卡片做中文词性标注（jieba.posseg），按词性从全局词池随机
组合出新的想法候选——发散思考的机械化入口（AXIOM §22.2：纯数据，
文案由 UI 层渲染）。
"""

import asyncio
import json
import random
from pathlib import Path

import jieba.posseg as pseg
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/canvas", tags=["canvas"])

# 组合模板：词性占位（n 名词 / v 动词 / a 形容词 / d 副词）+ 虚词
TEMPLATES = [
    ("n", "v", "n"),
    ("a", "的", "n"),
    ("n", "与", "n"),
    ("v", "n"),
    ("a", "的", "n", "v"),
    ("n", "v", "的", "a", "n"),
    ("v", "的", "n"),
]

POS_LABELS = {"n": "名词", "v": "动词", "a": "形容词", "d": "副词"}

_MAX_WORD_LEN = 6
_MIN_WORD_LEN = 2
_TARGET_COUNT = 10

# 内置结构性词库：用户只填名词/动词时，用这些词串起句子
# （可维护：GET/POST /api/canvas/wordbank 增删改，存 data/wordbank.json）
BUILTIN_WORDBANK: dict[str, list[str]] = {
    "conj": ["和", "与", "以及", "或者", "但是", "因为", "所以", "如果", "即使"],
    "prep": ["在", "从", "向", "把", "被", "为", "关于", "沿着", "穿过"],
    "aux": ["的", "地", "得", "了", "着", "过", "吗", "呢"],
    "adj": ["深沉的", "轻盈的", "锋利的", "温暖的", "破碎的", "沉默的", "炽热的", "模糊的"],
    "obj": ["梦境", "回声", "微光", "边界", "碎片", "仪式", "伤口", "地平线"],
}


def _wordbank_path() -> Path:
    from backend.config import settings

    return settings.data_dir / "wordbank.json"


def _load_wordbank() -> dict[str, list[str]]:
    """词库 = 内置 + 用户覆盖（data/wordbank.json 合并追加）。"""
    bank = {k: list(v) for k, v in BUILTIN_WORDBANK.items()}
    path = _wordbank_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            for k, v in data.items():
                if isinstance(v, list):
                    merged = list(bank.get(k, []))
                    for item in v:
                        if item not in merged:
                            merged.append(item)
                    bank[k] = merged
    except (OSError, json.JSONDecodeError):
        pass
    return bank


@router.get("/wordbank")
async def get_wordbank() -> dict:
    return _load_wordbank()


class WordbankUpdate(BaseModel):
    """{ category: [words...] } 全量覆盖用户词（内置词不受影响）。"""
    categories: dict[str, list[str]] = Field(default_factory=dict)


@router.post("/wordbank")
async def update_wordbank(req: WordbankUpdate) -> dict:
    """保存用户词库（与内置合并）。"""
    path = _wordbank_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    await asyncio.to_thread(
        path.write_text,
        json.dumps(req.categories, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return _load_wordbank()


class RemixRequest(BaseModel):
    cards: list[str] = Field(default_factory=list)


def _word_pool(cards: list[str]) -> dict[str, list[str]]:
    """jieba 词性标注：按首字母标签收集词语（去重保序）。"""
    pool: dict[str, list[str]] = {}
    for card in cards:
        for word in pseg.cut(card):
            text = word.word.strip()
            flag = word.flag or ""
            if not (_MIN_WORD_LEN <= len(text) <= _MAX_WORD_LEN):
                continue
            if text in {"的", "了", "是", "在", "和", "与", "我", "你"}:
                continue
            tag = flag[0] if flag else ""
            if tag not in POS_LABELS:
                continue
            bucket = pool.setdefault(tag, [])
            if text not in bucket:
                bucket.append(text)
    return pool


def _compose(
    pool: dict[str, list[str]],
    template: tuple[str, ...],
    structural: dict | None = None,
) -> str | None:
    parts: list[str] = []
    for item in template:
        if item in ("的", "与", "和", "以及", "或者", "但是", "因为", "所以", "如果", "即使"):
            parts.append(item)
            continue
        words = None
        if structural and item in ("conj", "prep", "aux", "obj"):
            words = structural.get(item) or []
        if not words:
            words = pool.get(item)
        if not words:
            return None
        parts.append(random.choice(words))
    return "".join(parts)


@router.post("/remix")
async def remix(req: RemixRequest) -> dict:
    """分析画布卡片词性，随机组合出灵感候选。"""
    cards = [c.strip() for c in req.cards if c.strip()]
    if not cards:
        raise HTTPException(status_code=422, detail="画布还没有内容")
    pool = _word_pool(cards)
    bank = _load_wordbank()
    # 结构性词库并入对应词性池（adj→a, conj/prep/aux→d 兜底 + 独立模板位）
    pool.setdefault("a", [])
    pool["a"] = list(dict.fromkeys(pool["a"] + bank.get("adj", [])))
    if not pool["n"] and not pool["v"]:
        raise HTTPException(status_code=422, detail="没有可分析的词语")
    structural = {
        "conj": bank.get("conj", []),
        "prep": bank.get("prep", []),
        "aux": bank.get("aux", []),
        "obj": bank.get("obj", []),
    }

    # 每张卡的词性概览（UI 展示用）
    per_card = []
    for card in cards:
        counts: dict[str, int] = {}
        for word in pseg.cut(card):
            flag = (word.flag or "")[:1]
            if flag in POS_LABELS and _MIN_WORD_LEN <= len(word.word.strip()) <= _MAX_WORD_LEN:
                counts[flag] = counts.get(flag, 0) + 1
        per_card.append(
            {
                "text": card[:40],
                "pos": {POS_LABELS[k]: v for k, v in sorted(counts.items(), key=lambda x: -x[1])},
            }
        )

    remixes: list[str] = []
    seen: set[str] = set()
    templates = list(TEMPLATES) + [
        ("n", "prep", "n", "v"),
        ("n", "conj", "n", "v"),
        ("a", "n", "v", "prep", "obj"),
        ("n", "v", "prep", "obj"),
        ("conj", "n", "v"),
    ]
    for _ in range(80):
        template = random.choice(templates)
        text = _compose(pool, template, structural)
        if text and text not in seen:
            seen.add(text)
            remixes.append(text)
        if len(remixes) >= _TARGET_COUNT:
            break

    return {
        "cards": per_card,
        "remixes": remixes,
        "pool": {POS_LABELS[k]: v[:12] for k, v in pool.items()},
        "wordbank": structural,
    }
