"""score step — AI-rubric scoring with cost gates, prefilter and low-score marking.

Items are scored via AIRouter.score(); scores below the configured minimum
(settings.pipeline_min_score) are marked is_lowscore instead of being
rejected — 低分可复用（参考原项目 Autarkeia），进入审核由人工决定。
只有硬性预过滤（reddit_score / upvote_ratio）会直接拒绝。

成本闸门（v0.2.1，参考原项目评分预算）：单次运行 / 单日 LLM 评分硬限额，
超限跳过评分（条目保持 downloaded，下轮或次日再评）——防 API 费用失控；
预过滤不花 API（廉价优先）。Failed scoring calls fail the item
(retryable via the engine's retry).
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import func, select

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)

# Reddit-side prefilter: posts under these values never reach the LLM
MIN_REDDIT_SCORE = 0
MIN_UPVOTE_RATIO = 0.0


class ScoreStep(Pipe):
    name = "score"
    input_statuses: tuple[str, ...] = ("downloaded",)

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

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        if item.reddit_score < MIN_REDDIT_SCORE:
            return ProcessResult(
                status="rejected", data={"reason": "reddit_score_below_prefilter"}
            )
        if item.upvote_ratio < MIN_UPVOTE_RATIO:
            return ProcessResult(
                status="rejected", data={"reason": "upvote_ratio_below_prefilter"}
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
        threshold = float(getattr(ctx.settings, "pipeline_min_score", 6.0))
        suitable = result.total >= threshold
        # 低分不丢弃：标记 is_lowscore 继续流程（人工审核决定），参考原项目「低分可复用」
        return ProcessResult(
            status="scored",
            data={
                "score_total": result.total,
                "score_dimensions": result.dimensions,
                "score_reasons": result.reasons,
                "score_fallback": result.fallback,
                "is_lowscore": not suitable,
            },
        )
