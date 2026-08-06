"""ScheduleManager — APScheduler wrapper with job audit hooks."""

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
        """Register a job by trigger kind: 'interval' | 'cron'."""
        if trigger == "interval":
            t = IntervalTrigger(**trigger_kwargs)
        elif trigger == "cron":
            t = CronTrigger(**trigger_kwargs)
        else:
            raise ValueError(f"Unknown trigger kind: {trigger}")
        self._scheduler.add_job(
            fn,
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
