"""score step — AI-rubric scoring with cost gates, prefilter, server-side
total recompute and the safety redline.

- 预过滤（v0.3.0，参考原项目 _prefilter_reject）：reddit_score/upvote_ratio
  廉价门槛（不花 LLM），仅当 reddit_score > 0 生效（RSS/空分源防误杀）
- 服务端重算 total（参考原项目 _finalize_score）：忽略 LLM 的 total，
  按维度权重加权平均（LLM 可能虚高/编造，服务端权威）
- safety 红线（参考原项目 safety≤3）：合规硬性拒绝——人工导入也不豁免，
  与「低分可复用」不同，safety 是合规边界
- 低分（非 safety）：标记 is_lowscore 继续流程（人工审核决定）
- **评分输入 = 正文（D-222）**：`score_input()` 决定模型看到什么，并记下 `basis`。
  从前这里硬拼 `subreddit / score` 两行、prompt 又把它标成「内容：」，于是八维里的
  completion / emotion 一直在给"标题 + 热度"打内容分。现在没正文就照实记 `title_only`，
  不猜、也不造一段看起来像内容的上下文。

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
from backend.pipeline.quality import MIN_STORY_CHARS

logger = logging.getLogger(__name__)

#: 送给评分模型的正文上限。prompt 侧还会再截一次（`ai/prompts/score.py` 的 3000 字），
#: 这一层先按字符截，是为了让"评分一次花多少 token"由这一步说了算，不受超长帖摆布。
SCORE_BODY_CHARS = 2400


def score_input(item) -> tuple[str, str]:
    """评分模型**实际看到的东西**，以及它是凭哪种输入打的分：`(content, basis)`。

    修这个函数之前，调用点硬拼的是 `f"subreddit: {…}\\nscore: {…}"`，而 prompt 把这段
    标成「内容：」——于是 `completion`（有没有头有尾）、`emotion`（情绪价值）这些维度
    全在给"标题 + 热度"打内容分，而且**理由里看不出这件事**（D-222）。

    两条规则：
    * 正文够长（阈值仍归 `quality.MIN_STORY_CHARS`，这里不复制数字）才送进去，记 `body`；
    * 没正文照实记 `title_only`——不猜、也不给模型造一段"看起来像内容"的上下文。
    """
    body = (getattr(item, "selftext", None) or "").strip()
    context = f"subreddit: {item.subreddit}\nscore: {item.reddit_score}"
    if len(body) >= MIN_STORY_CHARS:
        return f"{context}\n\n正文：\n{body[:SCORE_BODY_CHARS]}", "body"
    return context, "title_only"


#: `basis` 的两种取值（界面与评测脚本都读它，别处不许再发明第三种）
SCORE_BASES = ("body", "title_only")

# 维度权重（参考原项目：short_form 短视频适配加权、safety 合规加权、emotion 降权）
# v0.11.6 情感频道适配：emotion 0.9 → 1.3（情感类以转载内容为主，情绪价值是核心指标）
DIM_WEIGHTS: dict[str, float] = {
    "entertainment": 1.0,
    "novelty": 1.0,
    "completion": 1.0,
    "cultural_fit": 1.0,
    "short_form": 1.2,
    "visual_punch": 1.0,
    "emotion": 1.3,
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
        # v0.25 规则评分引擎：多信号启发式打分——高置信条目免 LLM。
        # 仅灰区（±margin 内）条目才调 LLM 增强（API 调用 ↓70%+）。
        if bool(getattr(ctx.settings, "pipeline_heuristic_scoring", True)):
            from backend.pipeline.producers.heuristic_score import (
                heuristic_score,
                is_gray_zone,
            )

            h_total, h_dims = heuristic_score(
                reddit_score=item.reddit_score,
                upvote_ratio=item.upvote_ratio,
                num_comments=item.num_comments,
                title=item.title or "",
                item_type=item.item_type,
                created_utc=item.created_at.timestamp() if item.created_at else 0,
            )
            threshold = float(getattr(ctx.settings, "pipeline_min_score", 6.0))
            if not is_gray_zone(h_total, threshold):
                suitable = h_total >= threshold
                return ProcessResult(
                    status="scored",
                    data={
                        "score_total": h_total,
                        # 规则引擎只看热度与标题（它压根没读正文），所以 basis 与 LLM 路同一个字段
                        "score_dimensions": {
                            **h_dims,
                            "engine": "heuristic",
                            "basis": "title_only",
                        },
                        "score_reasons": [f"规则引擎评分 {h_total}（仅标题与热度）"],
                        "is_lowscore": not suitable,
                    },
                )

        # 成本闸门：预算耗尽 → 跳过（保持 downloaded，不消耗 LLM 调用）
        if await self._budget_left(ctx) <= 0:
            logger.info("score budget exhausted — skipping item %s", item.id)
            ctx.log("score budget exhausted — skipping (keep downloaded)")
            return ProcessResult(status="downloaded")
        # 月度预算阶梯（v0.25）：exceeded 时仅人工触发——自动批次跳过评分
        try:
            from backend.ai.costs import get_budget_state

            m_state = await get_budget_state(use_cache=True)
            if m_state is not None and m_state["level"] == "exceeded":
                logger.info("monthly budget exceeded — skip auto score for %s", item.id)
                ctx.log(
                    f"monthly budget exceeded ({m_state['used']}/{m_state['monthly']}) — skip score"
                )
                return ProcessResult(status="downloaded")
        except Exception:  # noqa: BLE001 — 预算查询失败不阻塞评分
            pass
        ai = ctx.ai
        if ai is None or not ai.llm_available:
            raise StepError("LLM provider not configured — cannot score")
        content, basis = score_input(item)
        result = await ai.score(
            title=item.title,
            content=content,
            source=item.source_url,
            # v0.14.1 溯源：ai_calls.task_id = item:<uuid>——成本页可跳转产物
            task_id=f"item:{item.id}",
        )
        ctx.scores_used += 1

        dims = dict(result.dimensions or {})
        reasons = list(result.reasons or [])
        # 「这次评分凭的是什么输入」由服务端记，不采信模型自报——它没有渠道知道我们喂了什么
        dims["basis"] = basis
        reasons.append("按正文打分" if basis == "body" else "仅凭标题与热度打分（无正文）")
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
