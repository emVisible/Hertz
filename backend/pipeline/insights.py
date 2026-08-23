"""频道洞察（v0.19 数据飞轮一期，VidPal feedback loop 精华借鉴）。

拉近 30 天已发布条目 → top/bottom by 播放 → LLM 分析「我的受众爱什么」
→ 结构化洞察落库（保留历史）；最新洞察注入评分 rubric 与脚本 prompt。

冷启动保护：published < MIN_SAMPLE 时拒绝生成（小样本误导）。
触发：手动 POST /api/ai/insights/generate（Dashboard 按钮）——成本可控，
不做自动周期。

职责单一：本模块只做「聚合 + LLM 分析 + 存储」；prompt 注入点在
router.score / media.generate_script（消费侧读取 latest）。
"""

import json
import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from backend.infrastructure.timeutils import local_day_str
from backend.models.pipeline import ChannelInsight
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

MIN_SAMPLE = 5  # 已发布条目少于此数不生成（§4.1 小样本契约）
WINDOW_DAYS = 30


async def latest() -> dict | None:
    """最近一次洞察（新→旧取首条）。"""
    async with session_factory() as session:
        row = (
            await session.execute(
                select(ChannelInsight).order_by(ChannelInsight.created_at.desc()).limit(1)
            )
        ).scalar_one_or_none()
    if row is None:
        return None
    data = dict(row.insights_json or {})
    data["generated_at"] = local_day_str(row.created_at)
    return data


def _summary_lines(rows) -> str:
    """条目 → 紧凑描述行（标题/subreddit/类型/AI分/播放/点赞）。"""
    lines = []
    for it in rows:
        stats = (it.publish_json or {}).get("stats") or {}
        score = f"{it.score_total:.1f}" if it.score_total is not None else "?"
        dur = ""
        d = (it.script_json or {}).get("duration_s") if it.script_json else None
        if d:
            dur = f" · {int(d)}s"
        lines.append(
            f"- [{local_day_str(it.published_at)}] {it.title[:60]} "
            f"(r/{it.subreddit}, {it.item_type}, AI{score}{dur}) "
            f"播放{stats.get('view', 0)} 赞{stats.get('like', 0)}"
        )
    return "\n".join(lines)


_INSIGHT_SYSTEM = """你是短视频频道数据分析师。根据某账号近一个月已发布视频的表现数据
（Top 高播放组 vs Bottom 低播放组），总结这个频道的受众偏好。输出 JSON：
{
  "audience_preferences": ["受众明显偏好的内容特征", ...],
  "hook_styles": ["表现好的开头/标题风格", ...],
  "avoid_topics": ["持续低表现的题材或形式", ...],
  "notes": "给下一期内容的一句话建议"
}
只依据数据说话；样本太小时如实说信息不足。只输出 JSON。"""


async def generate_insights(ai) -> dict:
    """生成并存储最新频道洞察；返回洞察 dict。样本不足抛 ValueError。"""
    from backend.ai.types import ChatMessage
    from backend.models.item import Item, ItemStatus

    now = datetime.now(UTC)
    cutoff = now - timedelta(days=WINDOW_DAYS)
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.status == ItemStatus.PUBLISHED,
                    Item.published_at.isnot(None),
                    Item.published_at >= cutoff,
                    Item.archived.is_(False),
                )
                .order_by(Item.published_at.desc())
            )
        ).scalars().all()

    def views(it):
        return ((it.publish_json or {}).get("stats") or {}).get("view") or 0

    published = [r for r in rows if r.published_at]
    if len(published) < MIN_SAMPLE:
        raise ValueError(
            f"已发布条目不足 {len(published)}/{MIN_SAMPLE} 条——先积累发布数据再生成洞察"
        )
    ranked = sorted(published, key=views, reverse=True)
    top, bottom = ranked[:5], ranked[-5:]

    user = (
        f"近 {WINDOW_DAYS} 天共 {len(published)} 条已发布视频。\n\n"
        f"【Top 高播放组】\n{_summary_lines(top)}\n\n"
        f"【Bottom 低播放组】\n{_summary_lines(bottom)}\n\n"
        "请按 system 要求输出 JSON。"
    )
    text = await ai.chat_messages(
        [ChatMessage(role="system", content=_INSIGHT_SYSTEM),
         ChatMessage(role="user", content=user)],
        role="main", max_tokens=1200,
        operation="insights", caller="pipeline",
    )
    parsed = _extract_json(text or "")
    if parsed is None:
        raise ValueError("insights: LLM 输出无法解析为 JSON")

    async with session_factory() as session:
        row = ChannelInsight(insights_json=parsed, source_count=len(published))
        session.add(row)
        await session.commit()
        row_id = row.id

    logger.info(
        "channel insights generated: id=%s sources=%d", row_id, len(published),
    )
    out = dict(parsed)
    out["generated_at"] = local_day_str(now)
    out["source_count"] = len(published)
    return out


def _extract_json(text: str) -> dict | None:
    t = (text or "").strip()
    if t.startswith("```"):
        t = t.strip("`").lstrip("json").strip()
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        obj = json.loads(t[start : end + 1])
        return obj if isinstance(obj, dict) else None
    except ValueError:
        return None


def prompt_suffix(latest_insight: dict | None) -> str:
    """最新洞察 → prompt 注入后缀（空/未启用返回 ""）。注入权重随样本量。"""
    if not latest_insight:
        return ""
    parts = []
    for key, label in (
        ("audience_preferences", "受众偏好"),
        ("hook_styles", "有效钩子"),
        ("avoid_topics", "应避开"),
    ):
        vals = latest_insight.get(key) or []
        if vals:
            parts.append(f"{label}：{'；'.join(str(v) for v in vals[:4])}")
    note = str(latest_insight.get("notes") or "").strip()
    if note:
        parts.append(note)
    if not parts:
        return ""
    body = "\n".join(f"- {p}" for p in parts)
    gen = latest_insight.get("generated_at", "")
    return f"\n\n频道洞察（基于本账号 {gen} 前的发布数据，创作时参考）：\n{body}"


__all__ = ["generate_insights", "latest", "prompt_suffix"]
