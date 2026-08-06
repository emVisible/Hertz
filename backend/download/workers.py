"""DownloadWorkerPool — asyncio task registry for download jobs.

Semantics mirror HeartStone's WorkerPool: tasks run with bounded
concurrency (via ConcurrencyLimiter), can be cancelled by id, and
failures are tracked per task. Backs DownloadService.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from backend.factory.concurrency import ConcurrencyLimiter

logger = logging.getLogger(__name__)


class DownloadWorkerPool:
    def __init__(self, limiter: ConcurrencyLimiter) -> None:
        self._limiter = limiter
        self._tasks: dict[str, asyncio.Task] = {}

    def running(self) -> list[str]:
        return [tid for tid, t in self._tasks.items() if not t.done()]

    def submit(self, task_id: str, coro_factory: Callable[[], Awaitable[None]]) -> asyncio.Task:
        async def wrapper() -> None:
            try:
                async with self._limiter.slot("download"):
                    await coro_factory()
            finally:
                self._tasks.pop(task_id, None)

        task = asyncio.create_task(wrapper(), name=f"download:{task_id}")
        self._tasks[task_id] = task
        return task

    def cancel(self, task_id: str) -> bool:
        task = self._tasks.get(task_id)
        if task is None:
            return False
        task.cancel()
        return True
