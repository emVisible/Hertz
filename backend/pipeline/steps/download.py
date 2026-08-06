"""download step — fetch the raw media for a scored item.

Reuses the Wave-2 ChunkedDownloader (Range-aware, resumable, SSRF-guarded).
The file lands under data/pipeline/{output_dir}/ and its path is stored on the
item as raw_path (absolute) for later production steps.
"""

import logging
from pathlib import Path

from backend.infrastructure.storage import next_output_slug
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


class DownloadStep(Pipe):
    name = "download"
    input_statuses: tuple[str, ...] = ("scored",)

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        url = item.media_url or item.source_url
        if not url:
            raise StepError("item has no source URL to download")
        from urllib.parse import urlparse

        from backend.download.engine import ChunkedDownloader, is_safe_media_url

        # SSRF guard (AXIOM §8.1): collector-supplied URLs are remote input.
        checker = is_safe_media_url
        if getattr(ctx.settings, "pipeline_allow_loopback_urls", False):
            checker = lambda u: urlparse(u).scheme in ("http", "https")  # noqa: E731
        if not checker(url):
            raise StepError(f"download refused: unsafe media URL ({url[:64]})")

        root = Path(ctx.settings.data_dir) / "pipeline"
        if not item.output_dir:
            # 结构化命名：pipeline/2026-08-04-01（日期 + 当日第几次），并持久化供后续步骤复用
            slug = next_output_slug(root)
            async with session_factory() as session:
                row = await session.get(type(item), item.id)
                if row is not None:
                    row.output_dir = f"pipeline/{slug}"
                    await session.commit()
            item.output_dir = f"pipeline/{slug}"
        directory = root / item.output_dir.split("/")[-1]
        dest = directory / "raw"
        ext = _ext_from(url)
        if ext:
            dest = dest.with_suffix(ext)

        downloader = ChunkedDownloader(url, dest, url_checker=checker)
        result = await downloader.download()
        if not result.ok:
            raise StepError(f"download failed: {result.error}")

        ctx.log(f"[download] {item.title[:40]} → {dest.name}")
        return ProcessResult(
            status="downloaded",
            data={"raw_path": str(dest.resolve())},
        )


def _ext_from(url: str) -> str:
    from urllib.parse import urlparse

    name = urlparse(url).path.rsplit("/", 1)[-1]
    if "." in name:
        return "." + name.rsplit(".", 1)[-1].lower()
    return ".mp4"
