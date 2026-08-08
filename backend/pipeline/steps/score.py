"""score step — AI-rubric scoring with prefilter and low-score marking.

Items are scored via AIRouter.score(); scores below the configured minimum
(settings.pipeline_min_score) are marked is_lowscore instead of being
rejected — 低分可复用（参考原项目 Autarkeia），进入审核由人工决定。
只有硬性预过滤（reddit_score / upvote_ratio）会直接拒绝。
Failed scoring calls fail the item (retryable via the engine's retry).
"""

import logging

from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)

# Reddit-side prefilter: posts under these values never reach the LLM
MIN_REDDIT_SCORE = 0
MIN_UPVOTE_RATIO = 0.0


class ScoreStep(Pipe):
    name = "score"
    input_statuses: tuple[str, ...] = ("downloaded",)

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        if item.reddit_score < MIN_REDDIT_SCORE:
            return ProcessResult(
                status="rejected", data={"reason": "reddit_score_below_prefilter"}
            )
        if item.upvote_ratio < MIN_UPVOTE_RATIO:
            return ProcessResult(
                status="rejected", data={"reason": "upvote_ratio_below_prefilter"}
            )
        ai = ctx.ai
        if ai is None or not ai.llm_available:
            raise StepError("LLM provider not configured — cannot score")
        result = await ai.score(
            title=item.title,
            content=f"subreddit: {item.subreddit}\nscore: {item.reddit_score}",
            source=item.source_url,
        )
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
