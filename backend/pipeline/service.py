"""PipelineService — execution-domain service facade.

Owns batch-run lifecycle (single-flight guard, background tasks), the item
review API and event wiring. The heavy lifting is delegated to StepEngine.
"""

import asyncio
import logging
from datetime import UTC, datetime

from backend.infrastructure.events import EventHub
from backend.models import script_keys as sk
from backend.models.item import Item
from backend.pipeline.engine import StepEngine
from backend.pipeline.helpers import _auto_tid  # noqa: F401 — _serialize 使用
from backend.pipeline.service_archive import ArchiveMixin
from backend.pipeline.service_compilation import CompilationOpsMixin
from backend.pipeline.service_prep import PrepOpsMixin
from backend.pipeline.service_promotion import PromotionMixin
from backend.pipeline.service_publish import PublishMixin
from backend.pipeline.service_queries import QueriesMixin
from backend.pipeline.service_review import ReviewMixin
from backend.pipeline.service_schedule import ScheduleMixin
from backend.pipeline.service_stats import StatsMixin

logger = logging.getLogger(__name__)
PRODUCE_MODULES = ("passthrough", "voice", "subtitle", "translate", "mute")


class PipelineService(
    ReviewMixin,
    PublishMixin,
    PromotionMixin,
    StatsMixin,
    PrepOpsMixin,
    ScheduleMixin,
    ArchiveMixin,
    CompilationOpsMixin,
    QueriesMixin,
):
    """执行域服务门面（v0.16 拆分为四域 Mixin——D-168 清偿）。

    本文件只保留运行控制核心（single-flight 批处理）；其余按域拆入
    service_review / service_publish / service_archive / service_queries。
    外部 import 路径不变（backend.pipeline.service.PipelineService）。
    """
    def __init__(self, hub: EventHub, engine: StepEngine) -> None:
        self.hub = hub
        self.engine = engine
        self._task: asyncio.Task | None = None
        self._current_job: str | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def current_job(self) -> str | None:
        return self._current_job


    # ---------- batch runs ----------

    async def run_batch(
        self, job_name: str, *, limit: int = 10, channel: str = "",
        input_statuses: tuple[str, ...] | None = None,
    ) -> dict:
        """批量运行（v0.10.1 异步队列化）：create_task 后台执行，立即返回入队。

        此前 `return await self._task` 让 HTTP 请求挂住直到全部条目处理完——
        前端"加入队列"后条目瞬间全部完成，看不到排队与进度。现后台跑，
        进度经 SSE（job_step / item / job_done）实时推送，任务状态经
        /pipeline/jobs 轮询。运行中并发提交仍 409（single-flight）。
        v0.11.10：input_statuses 覆盖透传（绕过评分直接下载）。"""
        if self.running:
            raise RuntimeError(f"pipeline busy with job '{self._current_job}'")
        self._current_job = job_name
        task = asyncio.create_task(
            self.engine.run_batch(
                job_name, limit=limit, channel=channel, input_statuses=input_statuses,
            ),
            name=f"pipeline-{job_name}",
        )
        task.add_done_callback(self._on_batch_done)
        self._task = task
        return {
            "status": "queued",
            "job": job_name,
            "queued_at": datetime.now(UTC).isoformat(),
        }

    def _on_batch_done(self, _task: asyncio.Task) -> None:
        self._current_job = None

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict:
        """collect → score → download → produce (stops at the review gate)。"""
        if self.running:
            raise RuntimeError(f"pipeline busy with job '{self._current_job}'")
        self._current_job = "chain"
        task = asyncio.create_task(
            self.engine.run_chain(limit=limit, channel=channel),
            name="pipeline-chain",
        )
        task.add_done_callback(self._on_batch_done)
        self._task = task
        return {"status": "queued", "job": "chain"}

    async def cancel(self) -> dict:
        if self._task is None or self._task.done():
            raise RuntimeError("no pipeline job in progress")
        self._task.cancel()
        return {"ok": True, "cancelling": True}

    # 共享序列化（四域 Mixin 经 self._serialize 使用；v0.22 后唯一一份——
    # D-187 清偿历史双定义/字段漂移）
    @staticmethod
    def _serialize(item: Item) -> dict:
        return {
            "id": str(item.id),
            "seq": item.seq,
            "status": item.status,
            "item_type": item.item_type,
            "source": item.source,
            "source_url": item.source_url,
            "media_url": item.media_url,
            "source_id": item.source_id,
            "title": item.title,
            "subreddit": item.subreddit,
            "author": item.author,
            "reddit_score": item.reddit_score,
            "upvote_ratio": item.upvote_ratio,
            "score_total": item.score_total,
            "score_dimensions": item.score_dimensions,
            "score_reasons": item.score_reasons or [],
            "is_lowscore": item.is_lowscore,
            # 空壳隔离（v0.33）：异常区专属池的判据，前端据此不再把它当可操作数据
            "is_invalid": item.is_invalid,
            "produce_options": item.produce_options,
            # 多素材合集编排（v0.35）：非合集条目恒为 None。编排面板靠它判断
            # 「这条是不是合集」——不暴露的话界面只能靠 source==compilation 猜，
            # 那个判据不在数据契约里（source 是采集来源语义，不是编排语义）。
            "clips": item.clips,
            # 制作优先级（v0.26）：批量队列拖拽排序落库
            "priority": item.priority,
            "raw_path": item.raw_path,
            "video_path": item.video_path,
            "cover_path": item.cover_path,
            "script_json": item.script_json,
            "publish_json": item.publish_json,
            # 发布队列相位（v0.12）：''=手动 / holding=预发布 / ready=发布队列
            "queue_phase": item.queue_phase,
            "error": item.error,
            "error_class": item.error_class,
            "retry_count": item.retry_count,
            # 归属栏目（v0.22 栏目化）：审核/发布卡据此展示栏目上下文
            "channel_key": item.channel_key,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            # 最近操作（v0.3.12）：状态迁移自动刷新（onupdate）——「最新在前」排序要素
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
            "approved_at": item.approved_at.isoformat() if item.approved_at else None,
            "scheduled_at": item.scheduled_at.isoformat() if item.scheduled_at else None,
            # 看板（v0.34 B）：今日关注日期 + 加工备注。序列化唯一作者在此，
            # 看板列的划分读的就是这两个字段（`board.build_columns` 不再自己查库取列）。
            "focus_date": item.focus_date.isoformat() if item.focus_date else None,
            "focus_note": item.focus_note,
            # 分区自动建议（v0.2.7，参考原项目 assign_bili_tid）：未手动设置时的推荐分区
            "auto_tid": (
                None
                if (item.script_json or {}).get(sk.BILI_TID)
                else _auto_tid(item)
            ),
            "published_at": item.published_at.isoformat() if item.published_at else None,
            # 软归档（wave10）：备用库标记
            "archived": item.archived,
        }

