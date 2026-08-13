"""score step — AI-rubric scoring with cost gates, prefilter, server-side
total recompute and the safety redline.

- 预过滤（v0.3.0，参考原项目 _prefilter_reject）：reddit_score/upvote_ratio
  廉价门槛（不花 LLM），仅当 reddit_score > 0 生效（RSS/空分源防误杀）
- 服务端重算 total（参考原项目 _finalize_score）：忽略 LLM 的 total，
  按维度权重加权平均（LLM 可能虚高/编造，服务端权威）
- safety 红线（参考原项目 safety≤3）：合规硬性拒绝——人工导入也不豁免，
  与「低分可复用」不同，safety 是合规边界
- 低分（非 safety）：标记 is_lowscore 继续流程（人工审核决定）

成本闸门（v0.2.1，参考原项目评分预算）：单次运行 / 单日 LLM 评分硬限额，
超限跳过评分（条目保持 discovered，下轮或次日再评）——防 API 费用失控。
Failed scoring calls fail the item (retryable via the engine's retry).
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import func, select

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)

# 维度权重（参考原项目：short_form 短视频适配加权、safety 合规加权、emotion 降权）
DIM_WEIGHTS: dict[str, float] = {
    "entertainment": 1.0,
    "novelty": 1.0,
    "completion": 1.0,
    "cultural_fit": 1.0,
    "short_form": 1.2,
    "visual_punch": 1.0,
    "emotion": 0.9,
    "safety": 1.1,
}

# safety 合规红线（参考原项目：儿童/血腥/政治敏感/版权风险 → ≤3 强制拒绝）
SAFETY_REDLINE = 3


def recompute_total(dimensions: dict) -> float:
    """服务端按权重重算总分（0–10，两位小数），忽略 LLM 自报 total。"""
    weighted = sum(
        DIM_WEIGHTS.get(k, 1.0) * float(v)
        for k, v in dimensions.items()
        if isinstance(v, (int, float))
    )
    total_weight = sum(
        DIM_WEIGHTS.get(k, 1.0)
        for k, v in dimensions.items()
        if isinstance(v, (int, float))
    )
    if total_weight <= 0:
        return 0.0
    return round(weighted / total_weight, 2)


class ScoreStep(Pipe):
    name = "score"
    input_statuses: tuple[str, ...] = ("discovered",)  # v0.8.6 评分先行

    async def _budget_left(self, ctx: StepContext) -> int:
        """剩余评分预算 = min(单次剩余, 单日剩余)。运行内计数挂在 ctx（每批共享）。"""
        max_run = int(getattr(ctx.settings, "pipeline_score_max_per_run", 50))
        max_day = int(getattr(ctx.settings, "pipeline_score_max_per_day", 100))
        used_run = int(getattr(ctx, "scores_used", 0))
        if used_run >= max_run:
            return 0
        day_left = max_day
        async with session_factory() as session:
            start = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
            scored_today = await session.execute(
                select(func.count(Item.id)).where(
                    Item.score_total.isnot(None),
                    Item.updated_at >= start,
                )
            )
            day_left = max(0, max_day - (scored_today.scalar_one() or 0))
        return min(max_run - used_run, day_left)

    async def _prefilter(self, ctx: StepContext, item) -> ProcessResult | None:
        """LLM 前廉价门槛（v0.3.0 配置化）：仅 reddit_score > 0 生效（空分源防误杀）。"""
        min_score = int(getattr(ctx.settings, "pipeline_prefilter_min_reddit_score", 50))
        min_ratio = float(getattr(ctx.settings, "pipeline_prefilter_min_upvote_ratio", 0.85))
        if item.reddit_score > 0 and item.reddit_score < min_score:
            return ProcessResult(
                status="rejected", data={"reason": "reddit_score_below_prefilter"}
            )
        if item.reddit_score > 0 and item.upvote_ratio < min_ratio:
            return ProcessResult(
                status="rejected", data={"reason": "upvote_ratio_below_prefilter"}
            )
        return None

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        pre = await self._prefilter(ctx, item)
        if pre is not None:
            return pre
        # 标题相似去重（v0.3.0，参考原项目 find_title_duplicate）：
        # 7 天窗口同指纹 → LLM 前直接拒绝（不花 API）
        from backend.pipeline.dedupe import find_title_duplicate

        if await find_title_duplicate(item.title):
            return ProcessResult(
                status="rejected", data={"reason": "title_duplicate"}
            )
        # 成本闸门：预算耗尽 → 跳过（保持 downloaded，不消耗 LLM 调用）
        if await self._budget_left(ctx) <= 0:
            logger.info("score budget exhausted — skipping item %s", item.id)
            ctx.log("score budget exhausted — skipping (keep downloaded)")
            return ProcessResult(status="downloaded")
        ai = ctx.ai
        if ai is None or not ai.llm_available:
            raise StepError("LLM provider not configured — cannot score")
        result = await ai.score(
            title=item.title,
            content=f"subreddit: {item.subreddit}\nscore: {item.reddit_score}",
            source=item.source_url,
        )
        ctx.scores_used += 1

        dims = dict(result.dimensions or {})
        reasons = list(result.reasons or [])
        # 服务端重算 total（v0.3.0）：LLM 自报 total 不采信
        total = recompute_total(dims)

        # safety 合规红线：≤3 强制拒绝（人工导入也不豁免，参考原项目）
        safety = dims.get("safety")
        if isinstance(safety, (int, float)) and safety <= SAFETY_REDLINE:
            reasons.append("safety 过低（合规风险，强制拒绝）")
            return ProcessResult(
                status="rejected",
                data={
                    "score_total": total,
                    "score_dimensions": dims,
                    "score_reasons": reasons,
                    "score_fallback": result.fallback,
                    "reason": "safety_redline",
                },
            )

        threshold = float(getattr(ctx.settings, "pipeline_min_score", 6.0))
        suitable = total >= threshold
        # 低分不丢弃：标记 is_lowscore 继续流程（人工审核决定），参考原项目「低分可复用」
        return ProcessResult(
            status="scored",
            data={
                "score_total": total,
                "score_dimensions": dims,
                "score_reasons": reasons,
                "score_fallback": result.fallback,
                "is_lowscore": not suitable,
            },
        )
