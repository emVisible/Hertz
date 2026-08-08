"""Publishers — push a finished item to an external platform.

Today only Bilibili via the biliup CLI (cookie-authenticated). The router
keeps the target table so future platforms plug in with one entry.
"""

import asyncio
import shutil
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


class ExportPublisher(Publisher):
    """Export-first 模式（v0.2.1，参考原项目 localize 导出包）：

    不直传平台（tiktok/youtube 等无自动上传凭据时），把成片 + 字幕 +
    标题/描述/来源整理成发布包写到 data/exports/<item_id>/，人工/半自动上传。
    同一产物目录可反复导出（幂等覆盖）。
    """

    name = "export"

    async def publish(self, ctx: StepContext, item) -> dict:
        from datetime import UTC, datetime

        if not item.video_path:
            raise PublisherError("item has no finished video to export")
        root = Path(ctx.settings.data_dir) / "exports"
        out_dir = root / str(item.id)
        await asyncio.to_thread(out_dir.mkdir, parents=True, exist_ok=True)

        async def _copy(src: str | None, name: str) -> bool:
            if not src:
                return False
            src_path = Path(src)
            if not await asyncio.to_thread(src_path.exists):
                return False
            # 视频可达数百 MB：拷贝走线程池，避免阻塞事件循环（AXIOM §7.2）
            await asyncio.to_thread(shutil.copy2, str(src_path), str(out_dir / name))
            return True

        video_copied = await _copy(item.video_path, "video.mp4")
        if not video_copied:
            raise PublisherError(f"video missing: {item.video_path}")
        await _copy(item.subtitle_path, "subs.srt")
        await _copy(item.cover_path, "cover.jpg")

        script = item.script_json or {}
        meta_lines = [
            f"# {script.get('bili_title') or item.title}",
            "",
            f"- 来源: {item.source_url}",
            f"- 作者: u/{item.author}",
            f"- AI 评分: {item.score_total}",
            f"- 导出时间: {datetime.now(UTC).isoformat()}",
            f"- 排期: {item.scheduled_at.isoformat() if item.scheduled_at else '无（人工定）'}",
            "",
            "## 描述",
            script.get("bili_desc") or item.title,
            "",
            "## 标签",
            script.get("bili_tags") or "(无)",
            "",
            "## 字幕",
            "subs.srt（如有）",
            "",
        ]
        await asyncio.to_thread(
            (out_dir / "README.md").write_text, "\n".join(meta_lines), encoding="utf-8"
        )
        files = sorted(p.name for p in out_dir.iterdir() if p.is_file())
        ctx.log(f"[publish] export package ready: {out_dir} ({len(files)} files)")
        return {
            "target": "export",
            "export_dir": str(out_dir),
            "files": files,
        }


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
        # 发布元数据单一真相源：script_json.bili_*（审核/发布环节经 update_meta 写入）
        script = item.script_json or {}
        title = script.get("bili_title") or item.title[:80]
        desc = script.get("bili_desc") or item.title[:200]
        cmd = [
            "biliup", "-u", cookie, "upload", str(video),
            "--submit", "web",
            "--title", title[:80],
            "--desc", desc,
        ]
        tags = script.get("bili_tags")
        if tags:
            cmd += ["--tag", str(tags)]
        copyright_ = script.get("bili_copyright")
        if copyright_ in (1, "1"):
            cmd += ["--copyright", "1"]
        # 分区 tid：条目显式设置优先，否则用配置默认（审核未设分区时兜底）
        tid = script.get("bili_tid") or getattr(ctx.settings, "pipeline_bili_default_tid", 0)
        if tid:
            cmd += ["--tid", str(tid)]
        # 排期发布：scheduled_at 存在 → biliup 定时上传（v5.10）
        if item.scheduled_at:
            cmd += ["--timedpublish", item.scheduled_at.strftime("%Y-%m-%d %H:%M")]
        out = await _run_cmd(cmd)
        ctx.log(f"[publish] biliup ok: {title}")
        tail = out.decode(errors="replace")[-200:]
        return {"target": "bilibili", "title": title, "stdout_tail": tail}


PUBLISHERS: dict[str, Publisher] = {
    "bilibili": BilibiliPublisher(),
    "export": ExportPublisher(),  # 导出包模式（tiktok/youtube 等人工/半自动上传）
    "noop": NoopPublisher(),
}


def publish_targets() -> list[str]:
    return list(PUBLISHERS)
