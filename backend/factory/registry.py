"""ServiceRegistry — the single wiring hub (singleton).

All upper layers obtain services through the registry instead of importing
implementations directly. This is what makes provider swaps and test mocks
one-file changes (AXIOM §2.2).
"""

import asyncio
import shutil
from pathlib import Path

from backend.ai.registry import ProviderRegistry
from backend.ai.router import TaskRouter
from backend.config import Settings, settings
from backend.download.service import DownloadService
from backend.download.workers import DownloadWorkerPool
from backend.factory.concurrency import ConcurrencyLimiter
from backend.factory.scheduler import ScheduleManager
from backend.infrastructure.events import EventHub
from backend.infrastructure.logging import LogManager, log_manager
from backend.infrastructure.storage import FileStore, file_store
from backend.orchestration.briefs import BriefService
from backend.orchestration.buffs import BuffService
from backend.orchestration.crews import CrewService
from backend.orchestration.depths import DepthService
from backend.orchestration.phases_service import PhasesService
from backend.orchestration.plans import PlanService
from backend.orchestration.roles import RoleService
from backend.orchestration.studio import StudioService
from backend.pipeline.engine import StepEngine
from backend.pipeline.service import PipelineService


class ServiceRegistry:
    _instance: "ServiceRegistry | None" = None

    @staticmethod
    def _migrate_legacy_output() -> None:
        """一次性迁移：Wave 6.18 前的产物在 cwd 下的 output/studio（cwd 解析），
        新代码锚定 data_dir/output/studio——旧 run 产物目录"消失"导致
        产物永远读不到。仅当目标不存在时搬移，幂等。
        """
        try:
            legacy = Path.cwd() / "output" / "studio"
            target = file_store.output_root() / "studio"
            if not legacy.is_dir() or legacy == target:
                return
            target.parent.mkdir(parents=True, exist_ok=True)
            moved = 0
            for entry in legacy.iterdir():
                if not entry.is_dir():
                    continue
                dest = target / entry.name
                if dest.exists():
                    continue
                shutil.move(str(entry), str(dest))
                moved += 1
            if moved:
                log_manager.get().info("migrated %d legacy run output dirs to %s", moved, target)
        except OSError:
            log_manager.get().exception("legacy output migration failed (best effort)")

    def __init__(self) -> None:
        self.log: LogManager = log_manager
        self.files: FileStore = file_store
        self.concurrency = ConcurrencyLimiter()
        self.scheduler = ScheduleManager()
        self.events = EventHub()
        self.download = DownloadService(
            pool=DownloadWorkerPool(self.concurrency),
            hub=self.events,
        )
        self.crews = CrewService()
        self.roles = RoleService()
        self.buffs = BuffService()
        self.depths = DepthService()
        self.briefs = BriefService()
        self.plans = PlanService()
        self.phases = PhasesService()
        self.studio = StudioService(files=file_store, hub=self.events)
        self.pipeline = PipelineService(
            hub=self.events,
            engine=StepEngine(
                hub=self.events,
                settings=settings,
                ai=None,
                collector=None,
            ),
        )
        self.ai: TaskRouter | None = None
        self.providers = ProviderRegistry()

    def initialize(self, settings: Settings) -> None:
        self._migrate_legacy_output()
        # v3.0：图像/TTS 全部走 Provider 注册表（TaskRouter 按角色解析）。
        # 无构造注入——应用层只依赖 TaskRouter 的稳定接口。
        self.ai = TaskRouter(registry=self.providers)
        from backend.pipeline.collectors.reddit import RedditCollector

        self.pipeline.engine.ai = self.ai
        self.pipeline.engine.collector = RedditCollector()
        # 周期性任务（v0.2.1，参考原项目 scheduler）：自动过审默认关闭，
        # 开启后每 5 分钟扫描超时未审条目（auto_approve 内部自查开关）
        self.scheduler.add_job(
            "auto_approve",
            self._auto_approve_tick,
            trigger="interval",
            minutes=5,
        )
        # 发布数据回捞（v0.4 C1）：每 6 小时扫一次已发布条目拉播放/互动
        self.scheduler.add_job(
            "publish_stats",
            self._publish_stats_tick,
            trigger="interval",
            hours=6,
        )
        self.log.get().info("ServiceRegistry initialized (AI via ProviderRegistry)")

    async def _auto_approve_tick(self) -> None:
        try:
            result = await self.pipeline.auto_approve()
            if result.get("approved", 0) > 0:
                self.log.get().info("auto_approve approved %d item(s)", result["approved"])
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("auto_approve tick failed (best effort)")

    async def _publish_stats_tick(self) -> None:
        try:
            result = await self.pipeline.refresh_publish_stats()
            if result.get("updated", 0) > 0:
                self.log.get().info(
                    "publish stats refreshed %d item(s)", result["updated"]
                )
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("publish stats tick failed (best effort)")

    async def shutdown(self) -> None:
        # Cancel in-flight background work before releasing resources
        # (AXIOM §4.2: fail fast, leave no zombie tasks writing to disk).
        pending = [self.studio._task, self.pipeline._task, *self.download.pool._tasks.values()]  # noqa: SLF001
        for task in pending:
            if task is not None and not task.done():
                task.cancel()
        if any(t is not None and not t.done() for t in pending):  # noqa: SLF001
            await asyncio.gather(
                *(t for t in pending if t is not None and not t.done()),
                return_exceptions=True,
            )
        self.scheduler.shutdown()
        collector = self.pipeline.engine.collector
        if collector is not None and hasattr(collector, "aclose"):
            await collector.aclose()
        if self.ai is not None:
            await self.ai.aclose()

    @classmethod
    def get(cls) -> "ServiceRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
