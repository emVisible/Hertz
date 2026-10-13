"""去重（v0.3.0，参考原项目 Autarkeia pipeline/dedupe.py）。

- 标题相似去重：归一化标题指纹（小写/去标点/截断），7 天窗口内同指纹
  重复 → score 前直接拒绝（LLM 前廉价去重，不花 API）
- phash 距离容差：汉明距离 ≤5 判重（替代精确相等——抽帧抖动/编码差异
  下同一视频的 phash 可能有几位翻转）
"""

import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, true

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


async def find_published_title_duplicate(
    title: str, exclude_id: object | None = None,
) -> bool:
    """**已发布**条目里有没有同标题指纹的——发布期的第二道闸（v0.38）。

    ## 为什么需要它（phash 闸有个大洞）

    发布闸原先是 `if item.phash: ...`。而文字故事的 phash 是**显式置空**的
    （`producers/story.py`：「无原始画面，phash 无意义」），于是对整条文字产线
    ——包括 AI 原创故事这条战略通道——**发布期零查重**。

    评分阶段确实有标题指纹查重，但那是**另一次调用、另一些行**：
    它比的是「近 7 天内 `score_total` 非空的条目」，而发布期真正该问的是
    「这条是不是已经发出去了」。条目一旦发布就不再被评分，那道闸也就再也够不着它。

    ## 与 phash 闸的关系

    两道闸互补，不重复：phash 抓**同画面**（同一素材被发两次，标题可能完全不同），
    标题指纹抓**同内容**（画面不同但标题一致，例如同一故事的两个译本）。
    两道都要过。

    ## 扫描范围比评分期那道宽

    不限 `score_total`，因为要判的是「已经发出去过」，与它有没有分无关。
    只看 PUBLISHED——那是「重复投稿」真正成立的范围。
    """
    key = normalize_title_key(title)
    if len(key) < TITLE_MIN_LEN:
        return False
    cutoff = datetime.now(UTC) - timedelta(days=TITLE_WINDOW_DAYS)
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.title)
                .where(
                    Item.created_at >= cutoff,
                    Item.status == ItemStatus.PUBLISHED,
                    Item.id != exclude_id if exclude_id is not None else true(),
                )
                .order_by(Item.created_at.desc())
                .limit(TITLE_SCAN_LIMIT)
            )
        ).scalars().all()
    return any(normalize_title_key(t) == key for t in rows if t)


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
