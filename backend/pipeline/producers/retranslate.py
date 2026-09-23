"""重新翻译产线（v0.22.x B 系解体，自 engine.retranslate 迁出）。

用户诉求链路：提取视频原声 → 中文字幕（原声保留、无 TTS、无旁白）。

职责边界（SRP）：
- 本模块 = 制作域（ASR 双通道 → 本地批量翻译 → ASS → 原声合成 →
  封面/phash/包装 → 条目落 queued/failed）
- engine.retranslate = 编排壳（条目校验、事件 emit、结果返回）

翻译引擎经 subtitles._translate_srt_cues 走本地 Opus-MT 批量（D-189）。
"""

import asyncio
import logging
import os
import uuid
from pathlib import Path

from backend.ai.router import AIRouter
from backend.infrastructure.storage import FileStore
from backend.models import script_keys as sk
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import InvalidItemStateError
from backend.pipeline.helpers import bump_item_seq, load_item_for_action, purge_derived_media

logger = logging.getLogger(__name__)

__all__ = ["run_retranslate"]

async def run_retranslate(
    ai: AIRouter,
    files: FileStore,
    item_id: uuid.UUID,
    *,
    subtitle_lang: str | None = None,
) -> dict:
    """执行重翻译全流程并落库；失败标 failed 后抛 RuntimeError。"""
    from backend.config import settings as app_settings
    from backend.pipeline.package import generate_packaging
    from backend.pipeline.phash import compute_phash
    from backend.pipeline.producers.media import (
        ProducerError,
        _artifacts_dir,
        _asr_subtitles,
        compose_video,
        find_ffmpeg,
        generate_cover,
        srt_to_ass,
        subtitles_filter_available,
    )

    lang = str(subtitle_lang or getattr(app_settings, "pipeline_subtitle_lang", "zh-CN") or "zh-CN")
    async with session_factory() as session:
        item = await load_item_for_action(
            item_id,
            (
                ItemStatus.QUEUED, ItemStatus.APPROVED, ItemStatus.REJECTED,
                ItemStatus.FAILED, ItemStatus.DOWNLOADED, ItemStatus.SCORED,
            ),
            "retranslate",
        )
        raw_path = item.raw_path
        directory = _artifacts_dir(files, item)

        raw_ok = bool(raw_path and await asyncio.to_thread(os.path.exists, raw_path))
        if not raw_ok:
            raise InvalidItemStateError("item has no raw media — run download first")
        await purge_derived_media(item)
        item.status = ItemStatus.DOWNLOADED
        item.error = None
        item.error_class = ""
        await bump_item_seq(session, item)
        await session.merge(item)
        await session.commit()

    try:
        raw = Path(raw_path)
        result = await _asr_subtitles(ai, raw, directory, target_lang=lang)
        if result is None:
            raise ProducerError(
                "ASR unavailable — 执行 uv sync 安装 faster-whisper 主依赖，"
                "或配置 xinference STT"
            )
        srt_path, zh_text = result

        burn = srt_path
        ffmpeg = find_ffmpeg()
        if await subtitles_filter_available(ffmpeg):
            try:
                ass = srt_path.with_suffix(".ass")
                await asyncio.to_thread(srt_to_ass, srt_path, ass)
                burn = ass
            except Exception:  # noqa: BLE001 — subtitles are best-effort
                pass

        out_path = directory / "final.mp4"
        edit = await compose_video(raw, None, burn, out_path, muted=False)
        try:
            cover = await generate_cover(raw, directory / "cover.jpg")
        except ProducerError:
            cover = None

        phash = await compute_phash(str(out_path))

        async with session_factory() as session:
            row = await session.get(Item, item_id)
            if row is not None:
                row.video_path = edit["path"]
                row.subtitle_path = str(burn)
                row.cover_path = cover["path"] if cover else None
                row.audio_path = None
                row.phash = phash
                script = {
                    sk.MODE: "retranslate",
                    sk.SUBTITLE_ZH: zh_text,
                    sk.SOURCE: sk.SUB_FROM_ASR,
                }
                script = await generate_packaging(ai, row, script)
                row.script_json = script
                row.status = ItemStatus.QUEUED
                row.error = None
                row.error_class = ""
                await bump_item_seq(session, row)
                await session.merge(row)
                await session.commit()
    except Exception as exc:  # noqa: BLE001 — 失败标 failed，产物尽力保留
        logger.exception("retranslate failed for item %s", item_id)
        async with session_factory() as session:
            row = await session.get(Item, item_id)
            if row is not None:
                row.status = ItemStatus.FAILED
                row.error = str(exc)[:400]
                row.error_class = "retranslate"
                await session.merge(row)
                await session.commit()
        raise RuntimeError(f"retranslate failed: {exc}") from exc

    return {"id": str(item_id), "status": "queued", "action": "retranslate"}
