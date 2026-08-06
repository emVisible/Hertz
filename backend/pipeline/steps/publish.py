"""publish step — upload an approved item to its configured target.

The target is resolved through the publisher router (bilibili via biliup,
noop for dry runs). A missing/expired credential fails the item without
marking it rejected, so it can be retried after re-login.
"""

import logging

from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


class PublishStep(Pipe):
    name = "publish"
    input_statuses: tuple[str, ...] = ("approved",)

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        from backend.pipeline.publishers.router import PUBLISHERS

        target = getattr(ctx.settings, "pipeline_publish_target", "noop")
        publisher = PUBLISHERS.get(target)
        if publisher is None:
            raise StepError(f"unknown publish target '{target}'")
        try:
            result = await publisher.publish(ctx, item)
        except Exception as exc:  # noqa: BLE001 — classify any publisher failure
            raise StepError(f"publish failed: {exc}") from exc
        return ProcessResult(
            status="published",
            data={"publish_json": {"target": target, **result}},
        )
