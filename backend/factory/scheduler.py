"""ScheduleManager — APScheduler wrapper with job audit hooks."""

import inspect
from datetime import tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from backend.config import settings
from backend.infrastructure.logging import log_manager


def _resolve_timezone() -> tzinfo | None:
    """调度时区：默认**系统本地**，可由 `settings.scheduler_timezone` 覆盖。

    v0.37 之前这里写死 `Asia/Shanghai`。要说清楚的是：**当时并没有真的出 bug**——
    现有作业全是 `IntervalTrigger`（自动采集/发布/体检/备份…），间隔触发与时区无关。
    所以这不是一次线上事故修复，而是拆掉一颗地雷：

    - 一旦有人注册 `CronTrigger`（比如「每天 10:00 发」），墙钟就会按 CST 解释，
      而 `schedule.next_slot` 解析发布窗口用的是系统本地时区
      （`backend/pipeline/schedule.py` 的 `local_tz`）。两套时区会让「窗口」和
      「触发」各说各话，而且没有任何报错。
    - 写死一个时区默认等于替所有用户做了时区决定。发布窗口的语义本来就是
      「本地墙钟高峰时段」（见 config.py 的中文注释），调度器理应同口径。

    返回 `None` 表示交给 APScheduler 用系统本地。填了非法时区名也回落本地——
    时区写错不该让整个调度器起不来。
    """
    name = (getattr(settings, "scheduler_timezone", "") or "").strip()
    if not name:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, KeyError):
        log_manager.get().warning(
            "scheduler_timezone=%r 无法解析，回落系统本地时区", name
        )
        return None


class ScheduleManager:
    def __init__(self) -> None:
        self._scheduler = AsyncIOScheduler(timezone=_resolve_timezone())

    def start(self) -> None:
        if not self._scheduler.running:
            self._scheduler.start()
            log_manager.get().info("ScheduleManager started")

    def shutdown(self) -> None:
        if self._scheduler.running:
            self._scheduler.shutdown(wait=False)

    def add_job(self, name: str, fn: callable, trigger: str, **trigger_kwargs) -> None:
        """Register a job by trigger kind: 'interval' | 'cron'.

        **这里必须包一层 awaitable**（D-223）。APScheduler 3.x 用
        `iscoroutinefunction(func)` 决定「这个 callable 要不要 await」，而调用方传的是
        `lambda: self._timed(...)` —— lambda 本身不是协程函数，于是作业被丢进线程池执行，
        返回的协程对象**没有人 await**，Python 只留一句 `coroutine was never awaited` 的
        RuntimeWarning。结果是全部定时作业（自动采集 / 自动发布 / 数据体检 / 备份 /
        发布统计 / Telegram 轮询）注册成功、永不执行、也不报错。
        包成真正的 async 函数后，两种写法（传协程函数、传返回协程的 lambda）都走得通。
        """
        if trigger == "interval":
            t = IntervalTrigger(**trigger_kwargs)
        elif trigger == "cron":
            t = CronTrigger(**trigger_kwargs)
        else:
            raise ValueError(f"Unknown trigger kind: {trigger}")

        async def runner() -> None:
            result = fn()
            if inspect.isawaitable(result):
                await result

        self._scheduler.add_job(
            runner,
            trigger=t,
            id=name,
            name=name,
            replace_existing=True,
            misfire_grace_time=300,
        )
        log_manager.get().info("scheduled job '%s' (%s)", name, trigger)

    def jobs(self) -> list[dict]:
        return [
            {
                "id": j.id,
                "name": j.name,
                "next_run": j.next_run_time.isoformat() if j.next_run_time else None,
            }
            for j in self._scheduler.get_jobs()
        ]
