"""ConcurrencyLimiter — weighted per-task-kind concurrency caps.

Prevents one task family (e.g. LLM scoring) from starving another
(image generation, downloads). Applies across pipeline runs.
"""

import asyncio
from collections.abc import Awaitable
from contextlib import asynccontextmanager
from typing import Any

DEFAULT_LIMITS: dict[str, int] = {
    "llm": 4,
    "image": 2,
    "tts": 2,
    "download": 3,
    "pipeline": 2,
}


class ConcurrencyLimiter:
    def __init__(self, limits: dict[str, int] | None = None) -> None:
        self._limits = limits or DEFAULT_LIMITS
        self._semaphores: dict[str, asyncio.Semaphore] = {
            kind: asyncio.Semaphore(count) for kind, count in self._limits.items()
        }

    def limits(self) -> dict[str, int]:
        return dict(self._limits)

    @asynccontextmanager
    async def slot(self, kind: str):
        sem = self._semaphores.setdefault(kind, asyncio.Semaphore(1))
        async with sem:
            yield

    async def run(self, kind: str, coro: Awaitable[Any]) -> Any:
        async with self.slot(kind):
            return await coro
