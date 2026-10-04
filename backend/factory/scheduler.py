"""ScheduleManager — APScheduler wrapper with job audit hooks."""

import inspect

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from backend.infrastructure.logging import log_manager


class ScheduleManager:
    def __init__(self) -> None:
        self._scheduler = AsyncIOScheduler(timezone="Asia/Shanghai")

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
