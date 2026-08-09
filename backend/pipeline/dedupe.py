"""去重（v0.3.0，参考原项目 Autarkeia pipeline/dedupe.py）。

- 标题相似去重：归一化标题指纹（小写/去标点/截断），7 天窗口内同指纹
  重复 → score 前直接拒绝（LLM 前廉价去重，不花 API）
- phash 距离容差：汉明距离 ≤5 判重（替代精确相等——抽帧抖动/编码差异
  下同一视频的 phash 可能有几位翻转）
"""

import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory

# 标题指纹窗口与最小长度（参考原项目 title_window_days=7 / ≥6 字起效）
TITLE_WINDOW_DAYS = 7
TITLE_MIN_LEN = 6
TITLE_SCAN_LIMIT = 400

# phash 汉明距离容差（参考原项目 phash_max_distance=5）
PHASH_MAX_DISTANCE = 5

_PUNCT_RE = re.compile(r"[\W_]+", re.UNICODE)


def normalize_title_key(title: str) -> str:
    """标题指纹：小写 + 去标点 + 压缩空白，≤120 字。"""
    key = _PUNCT_RE.sub(" ", (title or "").lower())
    return re.sub(r"\s+", " ", key).strip()[:120]


def hamming_distance(a: str, b: str) -> int:
    """16 位十六进制 phash 的汉明距离（位数不同的字符按异或 popcount）。"""
    if not a or not b:
        return 999
    distance = 0
    for ca, cb in zip(a, b, strict=False):
        xor = int(ca, 16) ^ int(cb, 16)
        distance += xor.bit_count()
    return distance


async def find_title_duplicate(title: str) -> bool:
    """7 天窗口内是否存在同指纹的**已评分**条目（≥6 字起效）。

    只统计已评分条目（score_total 非空）：同批未评分的 discovered 条目
    不计——否则条目会命中自己/同批兄弟的未完成行（v0.3.0 查漏补缺）。
    """
    key = normalize_title_key(title)
    if len(key) < TITLE_MIN_LEN:
        return False
    cutoff = datetime.now(UTC) - timedelta(days=TITLE_WINDOW_DAYS)
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.title)
                .where(Item.created_at >= cutoff, Item.score_total.isnot(None))
                .order_by(Item.created_at.desc())
                .limit(TITLE_SCAN_LIMIT)
            )
        ).scalars().all()
    return any(normalize_title_key(t) == key for t in rows if t)


async def find_phash_duplicate(phash: str, exclude_id=None) -> bool:
    """汉明距离 ≤5 的已入库 phash 判重（QUEUED/APPROVED/PUBLISHED/REJECTED）。"""
    if not phash or len(phash) < 16:
        return False
    statuses = (
        ItemStatus.QUEUED, ItemStatus.APPROVED, ItemStatus.PUBLISHED, ItemStatus.REJECTED
    )
    async with session_factory() as session:
        stmt = select(Item.phash).where(
            Item.phash.isnot(None), Item.phash != "", Item.status.in_(statuses)
        )
        if exclude_id is not None:
            stmt = stmt.where(Item.id != exclude_id)
        rows = (await session.execute(stmt)).scalars().all()
    return any(hamming_distance(phash, p) <= PHASH_MAX_DISTANCE for p in rows if p)
