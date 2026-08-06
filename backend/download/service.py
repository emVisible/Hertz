"""DownloadService — task lifecycle orchestration.

Owns the DownloadTask table state machine (pending → downloading →
completed / failed / cancelled), dispatches to the right source
adapter, persists progress (throttled) and broadcasts events via
EventHub for SSE consumers. Partial files live next to targets as
`<name>.part` (+ `.part.json` sidecar) and resume on retry.
"""

import asyncio
import json
import logging
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import unquote, urlparse

import httpx
from sqlalchemy import select

from backend.config import settings
from backend.download.engine import ChunkedDownloader
from backend.download.errors import DownloadError
from backend.download.parser import parse_url
from backend.download.sources import BilibiliSource, GenericSource, YoutubeSource
from backend.download.workers import DownloadWorkerPool
from backend.infrastructure.events import EventHub
from backend.models.download import DownloadStatus, DownloadTask
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

SAFE_NAME_RE = re.compile(r"[^\w.\u4e00-\u9fff-]")
UA_HEADERS = {"User-Agent": "Mozilla/5.0 (Hertz/0.1)"}


def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(30.0), follow_redirects=True, headers=UA_HEADERS)


class DownloadService:
    def __init__(
        self,
        pool: DownloadWorkerPool,
        hub: EventHub,
        download_dir: Path | None = None,
        url_checker=None,
    ) -> None:
        self.pool = pool
        self.hub = hub
        self.download_dir = download_dir or settings.data_dir
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.url_checker = url_checker

    # ---------- discovery ----------

    async def describe(self, raw_url: str) -> dict:
        """Parse + resolve a URL into a candidate with selectable formats."""
        parsed = parse_url(raw_url)
        if parsed.provider == "bilibili":
            info = await BilibiliSource().describe(parsed.url)
        elif parsed.provider == "youtube":
            info = await YoutubeSource().describe(parsed.url)
        elif parsed.kind == "page":
            client = _make_client()
            try:
                assets = await GenericSource(client).scan_page(parsed.url)
            finally:
                await client.aclose()
            info = {"title": parsed.url, "assets": [a.__dict__ for a in assets]}
        else:
            client = _make_client()
            try:
                info = GenericSource(client).describe(parsed.url)
            finally:
                await client.aclose()
        return {"provider": parsed.provider, "kind": parsed.kind, **info}

    # ---------- task lifecycle ----------

    async def create_task(
        self, raw_url: str, project_id: uuid.UUID | None = None, title: str | None = None
    ) -> dict:
        parsed = parse_url(raw_url)
        meta: dict = {"kind": parsed.kind, "title_hint": parsed.title_hint}
        if title and title.strip():
            # 解析标题作为文件名来源（HeartStone：下载文件名 = 视频标题）
            meta["title_hint"] = title.strip()[:120]
        task = DownloadTask(
            url=parsed.url,
            provider=parsed.provider,
            project_id=project_id,
            metadata_json=meta,
        )
        async with session_factory() as session:
            session.add(task)
            await session.commit()
            await session.refresh(task)
        self._emit(task.id, "created", task)
        return self._serialize(task)

    async def start(self, task_id: uuid.UUID, format_id: str | None = None) -> dict:
        task = await self._load(task_id)
        if task is None:
            raise DownloadError("NOT_FOUND", "task not found")
        if task.status not in (
            DownloadStatus.PENDING,
            DownloadStatus.FAILED,
            DownloadStatus.CANCELLED,
        ):
            raise DownloadError("BAD_STATE", f"cannot start task in state {task.status}")
        task.status = DownloadStatus.DOWNLOADING
        task.error = None
        task.started_at = datetime.now(UTC)
        task.finished_at = None
        task.progress = 0.0
        task.downloaded_bytes = 0
        await self._save(task)
        self.pool.submit(str(task.id), lambda: self._run_task(task.id, format_id))
        self._emit(task.id, "started", task)
        return self._serialize(task)

    async def _run_task(self, task_id: uuid.UUID, format_id: str | None) -> None:
        task = await self._load(task_id)
        if task is None:
            return
        try:
            await self._execute(task, format_id)
            task.status = DownloadStatus.COMPLETED
            task.progress = 100.0
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            self._emit(task.id, "completed", task)
        except asyncio.CancelledError:
            task.status = DownloadStatus.CANCELLED
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            self._emit(task.id, "cancelled", task)
            raise
        except DownloadError as exc:
            task.status = DownloadStatus.FAILED
            task.error = str(exc)
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            self._emit(task.id, "failed", task)
        except Exception as exc:  # noqa: BLE001 — persist any failure
            logger.exception("download task %s crashed", task_id)
            task.status = DownloadStatus.FAILED
            task.error = f"internal: {exc}"
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            self._emit(task.id, "failed", task)

    async def _execute(self, task: DownloadTask, format_id: str | None) -> None:
        parsed = parse_url(task.url)
        if parsed.provider in ("bilibili", "youtube"):
            source = BilibiliSource() if parsed.provider == "bilibili" else YoutubeSource()
            dest = self._dest_for(task, "mp4")
            # 一次 describe 完成格式协商：默认格式 + 音轨合并判断 + 标题兜底
            info = await source.describe(task.url)
            if not (task.metadata_json or {}).get("title_hint"):
                meta = {**(task.metadata_json or {}), "title_hint": (info.get("title") or "")[:120]}
                task.metadata_json = meta
            fmt = format_id or self._default_format(info) or "best"
            chosen = next((f for f in info["formats"] if f["format_id"] == fmt), None)
            # 纯视频流（DASH 无音轨）必须合并最佳音轨，否则成片无声
            audio_id = None if (chosen and chosen.get("muxed")) else info.get("best_audio_id")
            await source.download(
                task.url, fmt, audio_id, dest, on_progress=self._progress_cb(task)
            )
            task.file_path = str(dest)
            await self._save(task)
            # 封面 sidecar（HeartStone 模式）：视频封面作为 *.thumb.jpg 就近存放
            await self._save_thumbnail(task, dest, info.get("thumbnail"))
            # Tag sidecar：下载素材自动打 download + 来源 tag
            await self._write_meta(task, dest, info)
            return

        dest = self._dest_for(task, _ext_of(task.url) or "bin")
        downloader = ChunkedDownloader(
            task.url,
            dest,
            on_progress=self._progress_cb(task),
            url_checker=self.url_checker,
        )
        result = await downloader.download()
        if not result.ok:
            raise DownloadError("FAILED", result.error or "download failed")
        task.file_path = str(dest)
        await self._save(task)

    async def _write_meta(self, task: DownloadTask, dest: Path, info: dict) -> None:
        """Tag sidecar：`<name>.meta.json` 记录 download + 来源 tag（素材系统第一公民）。"""
        try:
            from backend.library.browser import META_SUFFIX

            meta_path = Path(f"{dest}{META_SUFFIX}")
            data: dict = {}

            def _read() -> dict:
                try:
                    return json.loads(meta_path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    return {}

            data = await asyncio.to_thread(_read)
            if not isinstance(data, dict):
                data = {}
            data["tags"] = list(dict.fromkeys(["download", task.provider]))
            data["title"] = (task.metadata_json or {}).get("title_hint") or dest.stem
            data["url"] = task.url
            data["downloaded_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            await asyncio.to_thread(
                lambda: meta_path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            )
        except OSError:
            return

    async def _save_thumbnail(
        self, task: DownloadTask, dest: Path, thumbnail_url: str | None
    ) -> None:
        """Fetch the video thumbnail next to the file as `<name>.thumb.jpg`."""
        if not thumbnail_url or not str(thumbnail_url).startswith("http"):
            return
        import httpx

        thumb = Path(f"{dest}.thumb.jpg")
        try:
            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                resp = await client.get(thumbnail_url)
                resp.raise_for_status()
                if len(resp.content) < 256:
                    return
                await asyncio.to_thread(thumb.write_bytes, resp.content)
            if not task.metadata_json:
                task.metadata_json = {}
            task.metadata_json["thumbnail"] = str(thumb)
            await self._save(task)
        except (httpx.HTTPError, OSError):
            return

    def _default_format(self, info: dict) -> str | None:
        for f in info["formats"]:
            if f["kind"] == "video" and f["ext"] in ("mp4", "webm"):
                return f["format_id"]
        return None

    def _progress_cb(self, task: DownloadTask):
        last_db = 0.0

        async def cb(downloaded: int, total: int) -> None:
            nonlocal last_db
            task.downloaded_bytes = downloaded
            if total:
                task.total_bytes = total
                task.progress = min(100.0, round(downloaded / total * 100, 1))
            now = asyncio.get_running_loop().time()
            if now - last_db > 0.5 or downloaded >= total:
                last_db = now
                await self._save(task)
                self._emit(task.id, "progress", task)

        return cb

    async def cancel(self, task_id: uuid.UUID) -> dict:
        task = await self._load(task_id)
        if task is None:
            raise DownloadError("NOT_FOUND", "task not found")
        changed = False
        if self.pool.cancel(str(task_id)) and task.status == DownloadStatus.DOWNLOADING:
            task.status = DownloadStatus.CANCELLED
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            changed = True
        elif task.status == DownloadStatus.PENDING:
            # Never started: persist the cancellation so the event projection
            # and the DB agree (AXIOM §1.2 / §20.2).
            task.status = DownloadStatus.CANCELLED
            task.finished_at = datetime.now(UTC)
            await self._save(task)
            changed = True
        # Only emit when the state actually changed — no phantom events.
        if changed:
            self._emit(task.id, "cancelled", task)
        return self._serialize(task)

    async def retry(self, task_id: uuid.UUID) -> dict:
        return await self.start(task_id, format_id=None)

    async def delete(self, task_id: uuid.UUID) -> None:
        task = await self._load(task_id)
        if task is None:
            raise DownloadError("NOT_FOUND", "task not found")
        self.pool.cancel(str(task_id))
        await self._cleanup_files(task)
        async with session_factory() as session:
            await session.delete(task)
            await session.commit()

    async def list_tasks(self, limit: int = 50) -> list[dict]:
        async with session_factory() as session:
            result = await session.execute(
                select(DownloadTask).order_by(DownloadTask.created_at.desc()).limit(limit)
            )
            tasks = result.scalars().all()
        return [self._serialize(t) for t in tasks]

    # ---------- internals ----------

    def _dest_for(self, task: DownloadTask, ext: str) -> Path:
        hint = (task.metadata_json or {}).get("title_hint") or _name_of(task.url) or task.id.hex
        base = SAFE_NAME_RE.sub("_", hint).strip("._") or "download"
        # strip any extension the hint already carries so `.{ext}` is not duplicated
        if "." in base:
            base = base.rsplit(".", 1)[0]
        path = self.download_dir / f"{base}.{ext}"
        counter = 1
        while path.exists() and not Path(f"{path}.part").exists():
            path = self.download_dir / f"{base} ({counter}).{ext}"
            counter += 1
        return path

    async def _load(self, task_id: uuid.UUID) -> DownloadTask | None:
        async with session_factory() as session:
            return await session.get(DownloadTask, task_id)

    async def _save(self, task: DownloadTask) -> None:
        async with session_factory() as session:
            await session.merge(task)
            await session.commit()

    async def _cleanup_files(self, task: DownloadTask) -> None:
        for path in (task.file_path,):
            if not path:
                continue
            for suffix in ("", ".part", ".part.json"):
                await asyncio.to_thread(Path(f"{path}{suffix}").unlink, True)

    def _serialize(self, task: DownloadTask) -> dict:
        return {
            "id": str(task.id),
            "url": task.url,
            "provider": task.provider,
            "status": task.status,
            "progress": task.progress,
            "total_bytes": task.total_bytes,
            "downloaded_bytes": task.downloaded_bytes,
            "file_path": task.file_path,
            "error": task.error,
            "created_at": task.created_at.isoformat() if task.created_at else None,
            "metadata": task.metadata_json or {},
        }

    def _emit(self, task_id: uuid.UUID, event: str, task: DownloadTask) -> None:
        payload = {"event": event, "task": self._serialize(task)}
        self.hub.publish(f"download:{task_id}", payload)
        self.hub.publish("downloads", payload)


def _ext_of(url: str) -> str | None:
    path = unquote(urlparse(url).path)
    name = path.rsplit("/", 1)[-1]
    if "." in name:
        return name.rsplit(".", 1)[-1].lower()
    return None


def _name_of(url: str) -> str:
    path = unquote(urlparse(url).path)
    name = path.rsplit("/", 1)[-1]
    return name.rsplit(".", 1)[0] if "." in name else name
