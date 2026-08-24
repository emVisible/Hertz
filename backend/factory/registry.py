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
from backend.orchestration.brief_groups import BriefGroupService
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
        self.brief_groups = BriefGroupService()
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
        self.settings = settings
        self._migrate_legacy_output()
        # v3.0：图像/TTS 全部走 Provider 注册表（TaskRouter 按角色解析）。
        # 无构造注入——应用层只依赖 TaskRouter 的稳定接口。
        self.ai = TaskRouter(registry=self.providers)
        from backend.pipeline.collectors.reddit import RedditCollector

        self.pipeline.engine.ai = self.ai
        self.pipeline.engine.collector = RedditCollector()
        # 多源路由注册表（v0.22 非破坏性扩展）：前缀通道 → collector；
        # 裸名/未列前缀外的存量行为不变，新源仅在 pipeline_sources 显式添加后生效
        from backend.pipeline.collectors.ai_story import AIStoryCollector
        from backend.pipeline.collectors.rss import RssFeedCollector

        self.pipeline.engine.collectors = {
            "ai-story": AIStoryCollector(ai=self.ai),
            "rss": RssFeedCollector(),
        }
        # 周期性任务（v0.2.1，参考原项目 scheduler）：自动过审默认关闭，
        # 开启后每 5 分钟扫描超时未审条目（auto_approve 内部自查开关）
        self.scheduler.add_job(
            "auto_approve",
            lambda: self._timed("auto_approve", self._auto_approve_tick),
            trigger="interval",
            minutes=5,
        )
        # 发布数据回捞（v0.4 C1）：每 6 小时扫一次已发布条目拉播放/互动
        self.scheduler.add_job(
            "publish_stats",
            lambda: self._timed("publish_stats", self._publish_stats_tick),
            trigger="interval",
            hours=6,
        )
        # 自动采集（v0.8.2 职责重组）：采集只入 DB 数据量小，无需手动操心。
        # 固定每分钟 tick，间隔按运行时配置判断——改配置即时生效无需重启
        # （0=关闭仅手动）
        self.scheduler.add_job(
            "collect_auto",
            lambda: self._timed("collect_auto", self._collect_tick),
            trigger="interval",
            minutes=1,
        )
        # 自动发布队列（v0.12）：固定每分钟 tick，间隔按运行时配置判断
        # （pipeline_auto_publish_tick_minutes，默认 5）；总开关
        # pipeline_auto_publish 关闭时 tick 直接跳过
        self.scheduler.add_job(
            "auto_publish",
            lambda: self._timed("auto_publish", self._auto_publish_tick),
            trigger="interval",
            minutes=1,
        )
        # Telegram 审核 Bot（v0.18）：固定每分钟 tick（poll 内部 long-poll 25s）；
        # telegram_enabled=false 时 tick 直接跳过。推送与轮询同一 tick 串行。
        self.scheduler.add_job(
            "telegram_bot",
            lambda: self._timed("telegram_bot", self._telegram_tick),
            trigger="interval",
            minutes=1,
        )
        # DB 定时备份（v0.22 可见性补全）：每 24h pg_dump 滚动保留；
        # backup_enabled=false 或非 PG 后端时内部自查跳过
        if getattr(settings, "backup_enabled", True):
            self.scheduler.add_job(
                "db_backup",
                lambda: self._timed("db_backup", self._backup_tick),
                trigger="interval",
                hours=24,
            )
        self.log.get().info("ServiceRegistry initialized (AI via ProviderRegistry)")

    async def _timed(self, name: str, coro_fn) -> None:
        """tick 包装（v0.22 可见性）：计时 + telemetry 环形记录，失败吞掉。"""
        from backend.infrastructure.telemetry import timed_tick

        await timed_tick(name, coro_fn)

    async def _backup_tick(self) -> None:
        from backend.infrastructure.backup import run_backup

        result = await run_backup()
        if not result.get("ok"):
            raise RuntimeError(f"backup failed: {result.get('reason')}")

    async def _collect_tick(self) -> None:
        """自动采集：按配置间隔节流（运行中/间隔未到/关闭都跳过）。"""
        import time as _time

        from backend.config import settings  # 不依赖实例 initialize（单例直取）

        interval_min = int(
            getattr(settings, "pipeline_auto_collect_minutes", 30) or 0
        )
        if interval_min <= 0:
            return  # 关闭
        now = _time.time()
        last = getattr(self, "_last_auto_collect", 0.0)
        if now - last < interval_min * 60:
            return  # 间隔未到
        try:
            self._last_auto_collect = now
            limit = int(getattr(settings, "pipeline_collect_limit", 25) or 25)
            result = await self.pipeline.run_batch("collect", limit=limit)
            summary = result.get("summary") or {}
            if summary.get("collected", 0) > 0:
                self.log.get().info(
                    "auto collect: %d item(s) from %s",
                    summary["collected"], summary.get("sources", []),
                )
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("auto collect tick failed")
            raise

    async def _auto_approve_tick(self) -> None:
        try:
            result = await self.pipeline.auto_approve()
            if result.get("approved", 0) > 0:
                self.log.get().info("auto_approve approved %d item(s)", result["approved"])
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("auto_approve tick failed")
            raise

    async def _auto_publish_tick(self) -> None:
        """自动发布：按配置间隔节流；失败不拖垮调度器。"""
        import time as _time

        from backend.config import settings  # 不依赖实例 initialize（单例直取）

        interval_min = int(
            getattr(settings, "pipeline_auto_publish_tick_minutes", 5) or 5
        )
        now = _time.time()
        last = getattr(self, "_last_auto_publish", 0.0)
        if now - last < interval_min * 60:
            return
        try:
            self._last_auto_publish = now
            result = await self.pipeline.auto_publish_tick()
            if result.get("published", 0) > 0 or result.get("promoted", 0) > 0:
                self.log.get().info(
                    "auto publish: promoted=%d published=%d (used %s/%s)",
                    result["promoted"], result["published"],
                    result.get("used_today"), result.get("daily_limit"),
                )
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("auto publish tick failed")
            raise

    async def _telegram_tick(self) -> None:
        """Telegram 审核 Bot（v0.18）：回调轮询 + 待审推送，均 best-effort。"""
        import time as _time

        from backend.config import settings  # 不依赖实例 initialize（单例直取）
        from backend.integrations import telegram_bot as tg

        if not tg.enabled():
            return
        now = _time.time()
        # 推送节流：telegram_minutes（默认 1 分钟）——轮询每 tick 都跑（long-poll 挂起）
        last_push = getattr(self, "_last_tg_push", 0.0)
        try:
            await tg.poll_tick(self.pipeline)
            if now - last_push >= int(
                getattr(settings, "telegram_minutes", 1) or 1
            ) * 60:
                self._last_tg_push = now
                await tg.review_push_tick(self.pipeline)
            # 周报（v0.19）：7 天节流在函数内部
            await tg.weekly_report_tick(self.pipeline)
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("telegram tick failed")
            raise

    async def _publish_stats_tick(self) -> None:
        try:
            result = await self.pipeline.refresh_publish_stats()
            if result.get("updated", 0) > 0:
                self.log.get().info(
                    "publish stats refreshed %d item(s)", result["updated"]
                )
        except Exception:  # noqa: BLE001 — tick 失败不拖垮调度器
            self.log.get().exception("publish stats tick failed")
            raise

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
        # v0.22.x：多源路由——关闭默认 collector + 注册表中所有带 aclose 的实例
        collector = self.pipeline.engine.collector
        if collector is not None and hasattr(collector, "aclose"):
            await collector.aclose()
        for extra in self.pipeline.engine.collectors.values():
            if hasattr(extra, "aclose"):
                try:
                    await extra.aclose()
                except Exception:  # noqa: BLE001 — 关闭失败不阻塞停机
                    pass
        if self.ai is not None:
            await self.ai.aclose()

    @classmethod
    def get(cls) -> "ServiceRegistry":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance
