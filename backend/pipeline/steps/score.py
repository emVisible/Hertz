"""score step — AI-rubric scoring with prefilter and rejection threshold.

Items are scored via AIRouter.score(); scores below the configured minimum
(settings.pipeline_min_score, or with an unsuitable verdict) move to REJECTED
instead of SCORED. Failed scoring calls fail the item (retryable via the
engine's retry affordance).
"""

import logging

from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)

# Reddit-side prefilter: posts under these values never reach the LLM
MIN_REDDIT_SCORE = 0
MIN_UPVOTE_RATIO = 0.0


class ScoreStep(Pipe):
    name = "score"
    input_statuses: tuple[str, ...] = ("discovered",)

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
        if not suitable:
            return ProcessResult(
                status="rejected",
                data={
                    "score_total": result.total,
                    "score_dimensions": result.dimensions,
                    "score_reasons": result.reasons,
                    "reason": "below_min_score",
                },
            )
        return ProcessResult(
            status="scored",
            data={
                "score_total": result.total,
                "score_dimensions": result.dimensions,
                "score_reasons": result.reasons,
                "score_fallback": result.fallback,
            },
        )
