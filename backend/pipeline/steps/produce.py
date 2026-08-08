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

        try:
            artifacts = await produce_item(ai, registry.files, item)
        except ProducerError as exc:
            raise StepError(str(exc)) from exc

        video = artifacts.get("video")
        cover = artifacts.get("cover")
        audio = artifacts.get("audio")
        subtitle = artifacts.get("subtitle")

        return ProcessResult(
            status="queued",
            data={
                "script_json": artifacts.get("script"),
                "video_path": video["path"] if video else None,
                "cover_path": cover["path"] if cover else None,
                "audio_path": audio["path"] if audio else None,
                "subtitle_path": subtitle["path"] if subtitle else None,
                "phash": artifacts.get("phash"),
            },
        )
