"""运行遥测（v0.22 可见性补全）：调度 tick 环形记录 + 进程快照。

轻量内存方案（无新表）：每个 scheduler tick 收尾时记一行
（任务名/成败/耗时/错误摘要），保留最近 N 条；/api/metrics 暴露。
"""

import time
from collections import deque
from datetime import UTC, datetime

_STARTED_AT = time.time()
_TICKS: deque[dict] = deque(maxlen=100)


def record_tick(job: str, ok: bool, duration_ms: int, error: str = "") -> None:
    _TICKS.append(
        {
            "job": job,
            "ok": ok,
            "duration_ms": duration_ms,
            "error": error[:200],
            "at": datetime.now(UTC).isoformat(),
        }
    )


async def timed_tick(job: str, coro_fn) -> None:
    """包装 scheduler 回调：计时 + 记录 + 失败吞掉（不拖垮调度器）。"""
    t0 = time.perf_counter()
    try:
        await coro_fn()
        record_tick(job, True, int((time.perf_counter() - t0) * 1000))
    except Exception as exc:  # noqa: BLE001 — tick 失败不拖垮调度器
        record_tick(job, False, int((time.perf_counter() - t0) * 1000), str(exc))
        raise


def snapshot() -> dict:
    return {
        "version_marker": "telemetry-v1",
        "uptime_s": int(time.time() - _STARTED_AT),
        "started_at": datetime.fromtimestamp(_STARTED_AT, UTC).isoformat(),
        "ticks": list(_TICKS),
    }
