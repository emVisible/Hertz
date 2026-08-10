"""download step — fetch the raw media for a scored item.

Reuses the Wave-2 ChunkedDownloader (Range-aware, resumable, SSRF-guarded).
v0.2.9（参考原项目 Autarkeia download.py）：候选链降级 + CDN 熔断 +
条间节奏 + 请求头补齐——单 URL 404 不再整条失败。

流程：
1. CDN 熔断中 → 条目保持 discovered（不 FAILED），保护队列
2. 候选链（DASH 变体 → 原 URL → permalink）逐个尝试
3. 403 → 熔断记账；404/网络 → 下一候选；全失败 → 可读 StepError
4. 静图（image_gallery）：大小上限 + 最小字节校验 + 独立重试
"""

import logging
from pathlib import Path

from backend.infrastructure.storage import next_output_slug
from backend.models.session import session_factory
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError

logger = logging.getLogger(__name__)


class DownloadStep(Pipe):
    name = "download"
    input_statuses: tuple[str, ...] = ("discovered",)

    async def process(self, ctx: StepContext, item) -> ProcessResult:
        from urllib.parse import urlparse

        from backend.download.engine import ChunkedDownloader, is_safe_media_url
        from backend.pipeline.download import (
            STILL_MAX_BYTES,
            STILL_MIN_BYTES,
            cdn_circuit_open,
            cdn_circuit_remaining,
            download_headers,
            download_pacing,
            looks_like_manifest,
            media_candidates,
            reset_cdn_circuit,
            trip_cdn_circuit,
        )

        url = item.media_url or item.source_url
        if not url:
            raise StepError("item has no source URL to download")

        # SSRF guard (AXIOM §8.1): collector-supplied URLs are remote input.
        checker = is_safe_media_url
        if getattr(ctx.settings, "pipeline_allow_loopback_urls", False):
            checker = lambda u: urlparse(u).scheme in ("http", "https")  # noqa: E731

        # CDN 熔断：保护队列——剩余条目保持状态，冷却后重试
        if cdn_circuit_open():
            left = cdn_circuit_remaining()
            ctx.log(f"[download] CDN cooling down ({left}s left) — skipping")
            return ProcessResult(status="discovered")

        candidates = media_candidates(url, item.source_url, checker=checker)
        if not candidates:
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

        await download_pacing()  # 条间延迟 + 抖动（防节奏整齐被封）

        is_still = (item.item_type or "") == "image_gallery"
        last_error = ""
        for attempt in range(3 if is_still else 1):
            for cand in candidates:
                try:
                    downloader = ChunkedDownloader(
                        cand, dest,
                        headers=download_headers(cand),
                        url_checker=checker,
                    )
                    result = await downloader.download()
                except Exception as exc:  # noqa: BLE001 — 候选级失败继续下一候选
                    last_error = f"{cand[:48]}: {exc}"
                    continue
                if not result.ok:
                    # 403 附排查提示（v0.3.0，参考原项目 AccessDenied 语义）
                    hint = ""
                    if result.status == 403:
                        hint = "（CDN 拒绝——检查网络/代理/Reddit Cookie）"
                    last_error = f"{cand[:48]}: {result.error}{hint}"
                    status = result.status
                    if status == 403:
                        if trip_cdn_circuit():
                            # 熔断刚触发：剩余候选同 CDN 大概率全拒，直接放弃本轮
                            ctx.log("[download] CDN 403 — circuit tripped")
                            return ProcessResult(status="discovered")
                    else:
                        reset_cdn_circuit()  # 非 403 重置连续计数
                    continue
                reset_cdn_circuit()
                size = dest.stat().st_size if dest.exists() else 0
                # 内容嗅探（v0.2.9 查漏补缺）：误下 MPD/HLS 清单文本 → 丢弃继续下一候选
                if size > 0:
                    head = dest.read_bytes()[:512]
                    if looks_like_manifest(head):
                        last_error = f"{cand[:48]}: manifest text, not media"
                        dest.unlink(missing_ok=True)
                        continue
                if is_still and (size < STILL_MIN_BYTES or size > STILL_MAX_BYTES):
                    last_error = (
                        f"{cand[:48]}: still size {size} out of "
                        f"[{STILL_MIN_BYTES}, {STILL_MAX_BYTES}]"
                    )
                    dest.unlink(missing_ok=True)
                    continue
                ctx.log(f"[download] {item.title[:40]} → {dest.name} ({size} bytes)")
                return ProcessResult(
                    status="downloaded",
                    data={"raw_path": str(dest.resolve())},
                )
            if attempt < 1:
                dest.unlink(missing_ok=True)  # 重试前清残留

        raise StepError(f"download failed: {last_error or 'all candidates failed'}")

    # ---------- internals ----------


def _ext_from(url: str) -> str:
    from urllib.parse import urlparse

    name = urlparse(url).path.rsplit("/", 1)[-1]
    if "." in name:
        return "." + name.rsplit(".", 1)[-1].lower()
    return ".mp4"
