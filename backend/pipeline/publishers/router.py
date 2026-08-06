"""Publishers — push a finished item to an external platform.

Today only Bilibili via the biliup CLI (cookie-authenticated). The router
keeps the target table so future platforms plug in with one entry.
"""

import asyncio
from abc import ABC, abstractmethod
from pathlib import Path

from backend.pipeline.base import StepContext


class PublisherError(RuntimeError):
    """Raised when publishing fails (missing credentials, upload error…)."""


class Publisher(ABC):
    name: str = ""

    @abstractmethod
    async def publish(self, ctx: StepContext, item) -> dict:
        """Upload a produced item; return publisher-specific result data."""
        ...


class NoopPublisher(Publisher):
    """Target that records intent without uploading (test/ops safety)."""

    name = "noop"

    async def publish(self, ctx: StepContext, item) -> dict:
        ctx.log(f"[publish] (noop) would publish {item.title}")
        return {"target": "noop", "dry_run": True}


class BilibiliPublisher(Publisher):
    name = "bilibili"

    def __init__(self, cookie_path: str | None = None) -> None:
        self._cookie_path = cookie_path

    async def publish(self, ctx: StepContext, item) -> dict:
        if not item.video_path:
            raise PublisherError("item has no finished video to publish")
        from backend.pipeline.producers.media import _run_cmd

        cookie = self._cookie_path or str(ctx.settings.data_dir / "bilibili.cookie")
        if not await asyncio.to_thread(Path(cookie).exists):
            hint = f"run `biliup -u {cookie} login`"
            raise PublisherError(f"bilibili cookie file not found: {cookie} ({hint})")
        video = Path(item.video_path)
        if not await asyncio.to_thread(video.exists):
            raise PublisherError(f"video missing: {video}")
        script = item.script_json or {}
        title = script.get("bili_title") or item.title[:80]
        desc = script.get("bili_desc") or item.title[:200]
        cmd = [
            "biliup", "-u", cookie, "upload", str(video),
            "--submit", "web",
            "--title", title[:80],
            "--desc", desc,
        ]
        out = await _run_cmd(cmd)
        ctx.log(f"[publish] biliup ok: {title}")
        tail = out.decode(errors="replace")[-200:]
        return {"target": "bilibili", "title": title, "stdout_tail": tail}


PUBLISHERS: dict[str, Publisher] = {
    "bilibili": BilibiliPublisher(),
    "noop": NoopPublisher(),
}


def publish_targets() -> list[str]:
    return list(PUBLISHERS)
