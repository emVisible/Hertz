"""produce step — script → TTS → subtitles → video → cover for a downloaded item.

Degrades gracefully: TTS failure → subs-only; ffmpeg failure → script+raw
remain; only a total failure (no media at all) marks the item failed.
"""

import logging

from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


class ProduceStep(Pipe):
    name = "produce"
    input_statuses: tuple[str, ...] = ("scored",)

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        from backend.factory.registry import ServiceRegistry  # deferred import

        registry = ServiceRegistry.get()
        ai = ctx.ai if ctx.ai is not None else registry.ai
        from backend.pipeline.producers.media import ProducerError, produce_item

        # 重新翻译（v0.2.7）：保留已有脚本，只重跑 TTS/字幕/合成
        existing_script = dict(item.script_json) if item.script_json else None
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
