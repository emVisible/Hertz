"""ConcurrencyLimiter — weighted per-task-kind concurrency caps.

Prevents one task family (e.g. LLM scoring) from starving another
(image generation, downloads). Applies across pipeline runs.

## 为什么上限可以调（v0.37）

原先 `DEFAULT_LIMITS` 是写死的字典，任何人都改不了。对付费 API 配高额度、
或有独立显卡的用户，4 个并发 LLM 调用是凭空施加的天花板，而唯一的「解法」
是改源码重编译。对只有 2 核笔记本的用户，3 个并发下载反而会互相抢带宽。

所以改成读 `settings.concurrency_*`。但**不是**构造时读一次——本项目的
settings 是运行期可改的（`data/runtime.yaml`），构造时冻结会让「改完不生效」
变成新的假旋钮，而那正是这一轮要消灭的东西。

## 运行期改上限怎么做才不会出错

`asyncio.Semaphore` 的等待队列在构造时就固定了，没法安全地「调大调小」。这里
的做法是：**值变了就换一个新的 semaphore**。

已经排队等旧 semaphore 的人不会被唤醒（他们继续等旧的），但持有者正常释放，
旧信号量最终排空，于是不会死锁。换新的那一刻并发数会短暂超过新上限——
这是可接受的瞬态，好过让用户「改了设置却不生效」或引入死锁。
"""

import asyncio
from collections.abc import Awaitable
from contextlib import asynccontextmanager
from typing import Any

from backend.config import settings

#: 各任务族的默认并发上限。这些值同时是 settings 字段的默认值——
#: 改这里等于改「用户什么都不配时的行为」，改 settings 则只影响单个用户。
DEFAULT_LIMITS: dict[str, int] = {
    "llm": 4,
    "image": 2,
    "tts": 2,
    "download": 3,
    "pipeline": 2,
}


def limits_from_settings() -> dict[str, int]:
    """从 settings 读各任务族并发上限，非法值静默回落到默认值。

    静默回落而不是抛异常：并发上限是保护措施，用户把它填成 0 或负数时，
    让整个流水线起不来，比悄悄用默认值糟糕得多。但也不能完全不说——
    非法的值会被钳到 1（下限），1 总比 0 死锁强。
    """
    out: dict[str, int] = {}
    for kind, default in DEFAULT_LIMITS.items():
        raw = getattr(settings, f"concurrency_{kind}", None)
        try:
            value = int(raw) if raw is not None else default
        except (TypeError, ValueError):
            value = default
        out[kind] = max(1, value)
    return out


class ConcurrencyLimiter:
    def __init__(self, limits: dict[str, int] | None = None) -> None:
        # 显式传入 limits = 测试与特殊场景钉死上限；不传则每次取 slot 时读 settings
        self._pinned = limits
        self._applied: dict[str, int] = {}
        self._semaphores: dict[str, asyncio.Semaphore] = {}

    def limits(self) -> dict[str, int]:
        return dict(self._limits())

    def _semaphore_for(self, kind: str) -> asyncio.Semaphore:
        current = self._limits()
        limit = max(1, int(current.get(kind, 1)))
        sem = self._semaphores.get(kind)
        # 值没变就复用同一个（否则每次取 slot 都换 semaphore，排队者永远等不到）
        if sem is None or self._applied.get(kind) != limit:
            sem = asyncio.Semaphore(limit)
            self._semaphores[kind] = sem
            self._applied[kind] = limit
        return sem

    def _limits(self) -> dict[str, int]:
        return self._pinned if self._pinned is not None else limits_from_settings()

    @asynccontextmanager
    async def slot(self, kind: str):
        async with self._semaphore_for(kind):
            yield

    async def run(self, kind: str, coro: Awaitable[Any]) -> Any:
        async with self.slot(kind):
            return await coro