"""Chunked download engine (asyncio + httpx).

Modeled on HeartStone's 8MB chunk / offset-write scheme, hardened with
Autarkeia's SSRF validation (scheme + DNS resolution check, per-hop
redirect validation). Supports range downloads with a `.part` progress
sidecar so interrupted downloads resume instead of restarting.

Layout on disk for `dest`:
  dest.part        — partial file (chunks written at absolute offsets)
  dest.part.json   — {"total": int|None, "done": [start, ...]} completed chunk starts
"""

import asyncio
import ipaddress
import json
import logging
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlparse
from uuid import uuid4

import aiofiles
import httpx

from backend.download.errors import HTTPStatusError, NoRangesError, SSRFBlockedError

logger = logging.getLogger(__name__)

CHUNK_SIZE = 8 * 1024 * 1024  # 8 MB
MAX_REDIRECTS = 5

ProgressCallback = Callable[[int, int], Awaitable[None]]  # (downloaded, total)


@dataclass
class DownloadResult:
    ok: bool
    status: int | None = None
    error: str | None = None


def is_safe_media_url(url: str) -> bool:
    """SSRF guard: https only, no embedded credentials, public IPs only."""
    p = urlparse(url)
    if p.scheme != "https":
        return False
    if p.username or p.password:
        return False
    host = p.hostname
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    return True


async def probe(
    client: httpx.AsyncClient,
    url: str,
    checker: Callable[[str], bool] | None = None,
) -> tuple[int | None, bool, dict]:
    """Learn content-length and range support. Returns (size, supports_ranges, headers)."""
    check = checker or is_safe_media_url
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if not check(current):
            raise SSRFBlockedError()
        resp = await client.head(current, follow_redirects=False)
        if resp.status_code in (301, 302, 303, 307, 308):
            current = urljoin(current, resp.headers.get("Location", ""))
            continue
        if resp.status_code in (403, 405, 404):
            return await _probe_via_get(client, current, check)
        if resp.status_code >= 400:
            raise HTTPStatusError(resp.status_code)
        size = resp.headers.get("Content-Length")
        accepts = (
            resp.headers.get("Accept-Ranges", "").lower() == "bytes"
            or "bytes" in resp.headers.get("Content-Range", "").lower()
        )
        return (int(size) if size else None, accepts, dict(resp.headers))
    raise HTTPStatusError(0, "too many redirects")


async def _probe_via_get(
    client: httpx.AsyncClient, url: str, checker: Callable[[str], bool]
) -> tuple[int | None, bool, dict]:
    """HEAD-less servers: request one byte via Range and read Content-Range."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        if not checker(current):
            raise SSRFBlockedError()
        resp = await client.get(
            current, headers={"Range": "bytes=0-0"}, follow_redirects=False
        )
        if resp.status_code in (301, 302, 303, 307, 308):
            current = urljoin(current, resp.headers.get("Location", ""))
            continue
        if resp.status_code == 206:
            content_range = resp.headers.get("Content-Range", "")
            total = int(content_range.rsplit("/", 1)[-1]) if "/" in content_range else None
            return (total, True, dict(resp.headers))
        if resp.status_code == 200:
            return (int(resp.headers.get("Content-Length") or 0), False, dict(resp.headers))
        raise HTTPStatusError(resp.status_code)
    raise HTTPStatusError(0, "too many redirects")


class ChunkedDownloader:
    def __init__(
        self,
        url: str,
        dest: Path,
        *,
        headers: dict[str, str] | None = None,
        chunk_size: int = CHUNK_SIZE,
        max_workers: int = 3,
        client: httpx.AsyncClient | None = None,
        on_progress: ProgressCallback | None = None,
        url_checker: Callable[[str], bool] | None = None,
    ) -> None:
        self.url = url
        self.dest = dest
        self.headers = headers or {}
        self.chunk_size = chunk_size
        self.max_workers = max_workers
        self.client = client or httpx.AsyncClient(
            timeout=httpx.Timeout(30.0), follow_redirects=True
        )
        self.on_progress = on_progress
        self.url_checker = url_checker or is_safe_media_url
        self._owns_client = client is None
        self._part = Path(f"{dest}.part")
        self._meta = Path(f"{dest}.part.json")
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    @property
    def part_path(self) -> Path:
        return self._part

    async def download(self) -> DownloadResult:
        try:
            await self._run()
            return DownloadResult(ok=True)
        except asyncio.CancelledError:
            self._cancelled = True
            raise
        except Exception as exc:  # noqa: BLE001 — surface as result, not exception
            return DownloadResult(ok=False, error=str(exc))
        finally:
            if self._owns_client:
                await self.client.aclose()

    async def _run(self) -> None:
        self.dest.parent.mkdir(parents=True, exist_ok=True)
        total, supports_ranges, _ = await probe(self.client, self.url, self.url_checker)

        if not supports_ranges:
            raise NoRangesError()
        if total is not None and total == 0:
            raise HTTPStatusError(0, "empty content")

        done = self._load_progress(total)
        if done.get("total") != total:
            done = {"total": total, "starts": set()}
        if total is not None and len(done["starts"]) * self.chunk_size >= total:
            await self._finalize(total)
            return

        chunk_starts = self._chunk_starts(total)
        pending = [s for s in chunk_starts if s not in done["starts"]]
        if not pending:
            await self._finalize(total)
            return

        sem = asyncio.Semaphore(self.max_workers)
        # Pre-create the part file so every chunk can open it r+b concurrently.
        if not self._part.exists():
            async with aiofiles.open(self._part, "wb"):
                pass

        async def fetch_chunk(start: int) -> None:
            async with sem:
                if self._cancelled:
                    return
                end = (
                    start + self.chunk_size - 1
                    if total is None
                    else min(start + self.chunk_size - 1, total - 1)
                )
                if total is None:
                    await self._stream_range(self._part, start)
                else:
                    await self._write_range(self._part, start, end)
                done["starts"].add(start)
                await self._persist_progress(done)
                if self.on_progress:
                    await self.on_progress(len(done["starts"]) * self.chunk_size, total or 0)

        # One handle per chunk: aiofiles does not serialize seek/write on a
        # shared handle, so concurrent chunks would interleave (corruption).
        # Any failing chunk must surface instead of silently dropping part
        # files (AXIOM §4.2 — fail fast and loud).
        await asyncio.gather(*(fetch_chunk(s) for s in pending), return_exceptions=False)

        if self._cancelled:
            return
        await self._finalize(total)

    def _chunk_starts(self, total: int | None) -> list[int]:
        if total is None:
            return [0]
        return list(range(0, total, self.chunk_size))

    async def _write_range(self, part: Path, start: int, end: int) -> None:
        headers = {**self.headers, "Range": f"bytes={start}-{end}"}
        current = self.url
        for _ in range(MAX_REDIRECTS + 1):
            if not self.url_checker(current):
                raise SSRFBlockedError()
            resp = await self.client.get(current, headers=headers, follow_redirects=False)
            if resp.status_code in (301, 302, 303, 307, 308):
                current = urljoin(current, resp.headers.get("Location", ""))
                continue
            if resp.status_code == 416:
                return  # range satisfied by existing data
            if resp.status_code != 206:
                raise HTTPStatusError(resp.status_code)
            async with aiofiles.open(part, "r+b") as fh:
                await fh.seek(start)
                async for data in resp.aiter_bytes():
                    await fh.write(data)
            return
        raise HTTPStatusError(0, "too many redirects")

    async def _stream_range(self, part: Path, start: int) -> None:
        # Unknown-length servers send no Range header on the initial request.
        headers = {**self.headers}
        if start:
            headers["Range"] = f"bytes={start}-"
        current = self.url
        for _ in range(MAX_REDIRECTS + 1):
            if not self.url_checker(current):
                raise SSRFBlockedError()
            resp = await self.client.get(current, headers=headers, follow_redirects=False)
            if resp.status_code in (301, 302, 303, 307, 308):
                current = urljoin(current, resp.headers.get("Location", ""))
                continue
            if resp.status_code not in (200, 206):
                raise HTTPStatusError(resp.status_code)
            exists = await asyncio.to_thread(part.exists)
            async with aiofiles.open(part, "r+b" if exists else "wb") as fh:
                await fh.seek(start)
                async for data in resp.aiter_bytes():
                    await fh.write(data)
            return
        raise HTTPStatusError(0, "too many redirects")

    async def _finalize(self, total: int | None) -> None:
        if self._cancelled:
            return
        if total is None:
            # unknown length: streamed whole body already; nothing to verify
            pass
        await fh_sync(self._part, self.dest)
        self._part.unlink(missing_ok=True)
        self._meta.unlink(missing_ok=True)

    def _load_progress(self, total: int | None) -> dict:
        if not self._meta.exists():
            return {"total": total, "starts": set()}
        try:
            data = json.loads(self._meta.read_text(encoding="utf-8"))
            return {"total": data.get("total"), "starts": set(data.get("starts", []))}
        except (OSError, json.JSONDecodeError):
            return {"total": total, "starts": set()}

    async def _persist_progress(self, progress: dict) -> None:
        data = {"total": progress["total"], "starts": sorted(progress["starts"])}
        # 唯一临时名：并发 worker 各自写自己的 tmp 再原子替换——
        # 固定 tmp 名会互相竞争（A replace 后 B 的 tmp 已不存在 → ENOENT）。
        # 进度持久化是尽力而为（resume 时 _load_progress 兜底），失败不致命（AXIOM §4.6）。
        tmp = self._meta.with_name(f".{self._meta.name}.{uuid4().hex[:8]}.tmp")
        try:
            await asyncio.to_thread(tmp.write_text, json.dumps(data), "utf-8")
            await asyncio.to_thread(tmp.replace, self._meta)
        except OSError:
            logger.debug("progress persist failed (best effort)")


async def fh_sync(src: Path, dest: Path) -> None:
    await asyncio.to_thread(_copy_atomic, src, dest)


def _copy_atomic(src: Path, dest: Path) -> None:
    dest.unlink(missing_ok=True)
    src.replace(dest)
