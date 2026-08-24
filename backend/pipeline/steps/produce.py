"""produce step — script → TTS → subtitles → video → cover for a downloaded item.

Degrades gracefully: TTS failure → subs-only; ffmpeg failure → script+raw
remain; only a total failure (no media at all) marks the item failed.
"""

import logging

from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


class ProduceStep(Pipe):
    name = "produce"
    input_statuses: tuple[str, ...] = ("downloaded",)  # v0.8.6 评分先行

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        from backend.factory.registry import ServiceRegistry  # deferred import

        registry = ServiceRegistry.get()

        # 制作前预检（v0.22.x D-190）：按生产方式计算所需能力集。
        # 阻断项 → StepError 明确报错（不再中途静默降级产出不符预期内容）；
        # 警告项 → 记入 script_json.produce_warnings，审核卡可见。
        preflight_warnings, preflight_blockers = await _preflight(ctx, item)
        if preflight_blockers:
            raise StepError(
                "制作前置检查未通过：" + "；".join(preflight_blockers)
            )

        ai = ctx.ai if ctx.ai is not None else registry.ai
        from backend.pipeline.producers.media import ProducerError, produce_item

        # 脚本来源（v0.8.9 打回重制语义）：
        # - 首次制作（无成片）：用现有脚本（produce 已生成）或新生成
        # - 打回重制（已有成片 video_path）：完整重制——重新生成脚本，
        #   否则保留旧脚本重跑结果与上次相同（用户"打回再制作没效果"的根因）
        existing_script = (
            None
            if item.video_path
            else (dict(item.script_json) if item.script_json else None)
        )
        try:
            artifacts = await produce_item(
                ai, registry.files, item, existing_script=existing_script
            )
        except ProducerError as exc:
            raise StepError(str(exc)) from exc

        video = artifacts.get("video")
        cover = artifacts.get("cover")
        audio = artifacts.get("audio")
        subtitle = artifacts.get("subtitle")

        # 分区自动分配（v0.2.6，参考原项目 assign_bili_tid）：
        # 未手动设置 tid 时按 subreddit 推荐（审核页 Select 可改）
        script = dict(artifacts.get("script") or {})
        if preflight_warnings:
            script["produce_warnings"] = list(preflight_warnings)
        if not script.get("bili_tid"):
            from backend.pipeline.category import assign_bili_tid

            script["bili_tid"] = assign_bili_tid(item.subreddit, item.item_type or "video_raw")

        return ProcessResult(
            status="queued",
            data={
                "script_json": script,
                "video_path": video["path"] if video else None,
                "cover_path": cover["path"] if cover else None,
                "audio_path": audio["path"] if audio else None,
                "subtitle_path": subtitle["path"] if subtitle else None,
                "phash": artifacts.get("phash"),
            },
        )

async def _preflight(ctx: StepContext, item) -> tuple[list[str], list[str]]:
    """能力探测 → planner 输入。数据源：deps 缓存矩阵（启动/手动重测维护）。"""
    from backend.infrastructure.deps import (
        dep_ok,
        load_dependencies,
        refresh_dependencies,
    )
    from backend.pipeline.preflight import plan_capability_checks
    from backend.pipeline.producers.asr import asr_available

    deps = load_dependencies()
    if deps is None:
        deps = await refresh_dependencies()

    local_mt_ready = dep_ok(deps, "local_mt")
    tts_available: bool | None = None
    if ctx.ai is not None:
        try:
            tts_available = ctx.ai.tts_available
        except Exception:  # noqa: BLE001 — 解析失败按未知处理
            tts_available = None
    return plan_capability_checks(
        item.produce_options,
        local_mt_ready=local_mt_ready,
        tts_available=tts_available,
        asr_available=asr_available(),
        llm_ok=dep_ok(deps, "llm"),
    )
