"""StepEngine — batch executor for the content pipeline.

Drives Items through the five steps: collect → score → download → produce →
publish (v0.8.6: 评分先行——评分只读元数据不依赖文件，低分免下载；审核为人工
gate)。The engine owns status
transitions; each step only declares what it consumes and produces. Progress
is broadcast via EventHub on the ``pipeline`` topic; batch runs are recorded
in job_runs for audit.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.models.system import JobRun, JobStatus
from backend.pipeline.base import Pipe, ProcessResult, StepContext, StepError
from backend.pipeline.cancel import ItemCancelledError
from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError, classify_error
from backend.pipeline.steps import PIPELINE_ORDER, get_step
from backend.pipeline.steps.collect import run_collect

logger = logging.getLogger(__name__)

# Steps that consume items in status order; collect is batch-only.
# v5.9 流程：download → score → produce → (audit 人工) → publish


class StepEngine:
    def __init__(self, hub, settings, ai=None, collector=None, publishers=None) -> None:
        self.hub = hub
        self.settings = settings
        self.ai = ai
        self.collector = collector
        self.publishers = publishers or {}

    # ---------- public ----------

    async def run_batch(
        self, job_name: str, *, limit: int = 10, channel: str = "",
        input_statuses: tuple[str, ...] | None = None,
    ) -> dict:
        """Run one step (or the full chain) over ready items. Records a JobRun.

        v0.11.10：input_statuses 覆盖——绕过评分直接下载（unscored 批量）
        等特殊路径用；默认仍按 step.input_statuses 拉取。"""
        run_id = uuid.uuid4()
        job = JobRun(job_name=job_name, status=JobStatus.RUNNING)
        async with session_factory() as session:
            session.add(job)
            await session.commit()
            await session.refresh(job)

        ctx = StepContext(
            run_id=str(run_id),
            settings=self.settings,
            ai=self.ai,
            emit=lambda e: self._emit(str(job.id), e),
        )

        # 运行前后数据差异（v0.3.5）：各状态计数快照 → delta 随 job_done 下发
        before = await self._counts()

        try:
            summary = await self._run_step(
                ctx, job_name, limit=limit, channel=channel,
                input_statuses=input_statuses,
            )
            job.status = JobStatus.COMPLETED
            job.summary = summary
        except asyncio.CancelledError:
            job.status = JobStatus.FAILED
            job.error = "cancelled"
            raise
        except Exception as exc:  # noqa: BLE001 — persist the crash
            logger.exception("pipeline job %s crashed", job_name)
            job.status = JobStatus.FAILED
            job.error = str(exc)[:500]
            summary = {"error": str(exc)[:500]}
        finally:
            job.finished_at = datetime.now(UTC)
            async with session_factory() as session:
                await session.merge(job)
                await session.commit()

        summary = dict(summary or {})
        try:
            after = await self._counts()
            delta = {
                status: after.get(status, 0) - before.get(status, 0)
                for status in set(before) | set(after)
                if after.get(status, 0) != before.get(status, 0)
            }
            if delta:
                summary["delta"] = delta
        except Exception:  # noqa: BLE001 — diff 是增强，失败不阻塞主流程
            logger.warning("delta snapshot failed for job %s", job_name)
        job.summary = summary
        # v0.10.1 异步队列：delta 与最终 summary 落库（此前仅内存返回——
        # 同步模式前端拿响应体掩盖了缺口；异步后 jobs 列表/轮询读库）
        try:
            async with session_factory() as session:
                await session.merge(job)
                await session.commit()
        except Exception as exc:  # noqa: BLE001 — 落库失败不阻塞收尾
            logger.warning("final job summary persist failed: %s", exc)

        self._emit(
            str(job.id),
            {"type": "job_done", "job": job_name, "status": job.status, "summary": summary},
        )
        return {"job_id": str(job.id), "job": job_name, "status": job.status, "summary": summary}

    async def run_chain(self, *, limit: int = 10, channel: str = "") -> dict:
        """Run collect → download → score → produce in sequence (review gate before publish)."""
        results: dict[str, dict] = {}
        for step in PIPELINE_ORDER:
            if step == "publish":
                continue  # publish requires human approval
            results[step] = await self.run_batch(step, limit=limit, channel=channel)
        return results

    async def process_one(
        self, step_name: str, item_id: uuid.UUID,
        input_statuses: tuple[str, ...] | None = None,
    ) -> str:
        """单条处理（v0.3.4，预处理「制作」按钮）：指定步骤处理单个条目。

        复用 _process_item（状态落库 + 事件），返回 outcome（ok/rejected/failed）。
        v0.11.10：input_statuses 覆盖——绕过评分直接下载等宽松路径用。
        """
        step_cls = get_step(step_name)
        step = step_cls()
        async with session_factory() as session:
            item = await session.get(Item, item_id)
        if item is None:
            raise ItemNotFoundError(item_id)
        if item.status not in (input_statuses or step.input_statuses):
            raise InvalidItemStateError(
                f"step {step_name} cannot process item in state {item.status}"
            )
        ctx = StepContext(
            run_id=str(uuid.uuid4()),
            settings=self.settings,
            ai=self.ai,
            emit=lambda e: self._emit("item:" + item_id.hex, e),
        )
        # v0.11.3：单条操作开始即上报（SSE job_step）——前端终端/状态条
        # 立即感知「已开始加工」，不必等长任务（制作/翻译）HTTP 返回
        logger.info("manual %s started for item %s", step_name, item_id)
        self._emit(
            "pipeline",
            {"type": "job_step", "step": step_name, "count": 1, "item_id": str(item_id)},
        )
        outcome = await self._process_item(ctx, step, item)
        self._emit("pipeline", {"type": "job_step", "step": step_name, "count": 1})
        return outcome

    # ---------- per-item actions (review / retry) ----------

    async def approve(self, item_id: uuid.UUID) -> dict:
        from backend.pipeline.helpers import bump_item_seq, load_item_for_action

        async with session_factory() as session:
            item = await load_item_for_action(item_id, (ItemStatus.QUEUED,), "approve")
            item.status = ItemStatus.APPROVED
            item.approved_at = datetime.now(UTC)
            await bump_item_seq(session, item)  # v0.8.9：审核通过 = 最新入库序
            await session.merge(item)
            await session.commit()
        item_event = {"type": "item", "item_id": str(item_id), "status": "approved"}
        self._emit("item:" + item_id.hex, item_event)
        return {"id": str(item_id), "status": "approved"}

    async def reject(self, item_id: uuid.UUID, reason: str = "") -> dict:
        from backend.pipeline.helpers import bump_item_seq, load_item_for_action

        async with session_factory() as session:
            # v0.3.4：预处理阶段的 discovered（未下载）也可拒绝——人工筛掉不想要的源
            item = await load_item_for_action(
                item_id,
                (ItemStatus.QUEUED, ItemStatus.SCORED,
                 ItemStatus.DOWNLOADED, ItemStatus.DISCOVERED),
                "reject",
            )
            item.status = ItemStatus.REJECTED
            item.error = reason or "rejected at review"
            await bump_item_seq(session, item)  # v0.8.9
            await session.merge(item)
            await session.commit()
        item_event = {"type": "item", "item_id": str(item_id), "status": "rejected"}
        self._emit("item:" + item_id.hex, item_event)
        return {"id": str(item_id), "status": "rejected"}

    async def retry(self, item_id: uuid.UUID) -> dict:
        """Reset a failed item back to its previous state so a run picks it up again.

        v5.9 流程回退：有成片 → scored（重制）；已下载 → downloaded（重评分）；
        否则 → discovered（重下载）。
        """
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status != ItemStatus.FAILED:
                raise InvalidItemStateError(f"cannot retry item in state {item.status}")
            from backend.pipeline.helpers import back_status_for, bump_item_seq, purge_derived_media

            # v0.8.9 对齐原项目 reproduce（_REMAKE_STATUSES 含 FAILED）：
            # 重试前清除旧派生媒体，重跑必然全新产物
            await purge_derived_media(item)
            item.status = back_status_for(item)
            item.error = None
            item.retry_count += 1
            await bump_item_seq(session, item)  # v0.8.9：重试 = 最新入库序
            await session.merge(item)
            await session.commit()
        return {"id": str(item_id), "status": item.status}

    async def requeue(self, item_id: uuid.UUID) -> dict:
        """打回审核（v0.3.9 发布连通审核）：rejected/approved/published → queued。

        发布卡「打回审核」用：已发布/待发布条目重新进入审核队列。
        """
        from backend.pipeline.helpers import load_item_for_action

        async with session_factory() as session:
            item = await load_item_for_action(
                item_id,
                (ItemStatus.REJECTED, ItemStatus.APPROVED, ItemStatus.PUBLISHED),
                "requeue",
            )
            item.status = ItemStatus.QUEUED
            item.error = None
            await session.merge(item)
            await session.commit()
        self._emit(
            "item:" + item_id.hex, {"type": "item", "item_id": str(item_id), "status": "queued"}
        )
        return {"id": str(item_id), "status": "queued"}

    async def retranslate(self, item_id: uuid.UUID) -> dict:
        """重新翻译（v0.8.9，对齐原项目 retranslate_item）：
        提取视频原声 → 中文字幕（原声保留、无 TTS、无旁白）——用户诉求的
        「先提取视频原来的文字→转中文→打上字幕」。

        ASR 双通道（xinference 优先 / faster-whisper 兜底）→ LLM 逐段翻译
        （1:1 段数、保留原声时间戳）→ 中文 SRT → ASS → 原声合成。
        """
        from backend.config import settings
        from backend.factory.registry import ServiceRegistry
        from backend.pipeline.helpers import (
            bump_item_seq,
            load_item_for_action,
            purge_derived_media,
        )
        from backend.pipeline.producers.media import (
            ProducerError,
            _artifacts_dir,
            _asr_subtitles,
            compose_video,
            find_ffmpeg,
            generate_cover,
            srt_to_ass,
            subtitles_filter_available,
        )

        subtitle_lang = str(
            getattr(settings, "pipeline_subtitle_lang", "zh-CN") or "zh-CN"
        )

        registry = ServiceRegistry.get()
        ai = registry.ai

        async with session_factory() as session:
            item = await load_item_for_action(
                item_id,
                (
                    ItemStatus.QUEUED, ItemStatus.APPROVED, ItemStatus.REJECTED,
                    ItemStatus.FAILED, ItemStatus.DOWNLOADED, ItemStatus.SCORED,
                ),
                "retranslate",
            )
            raw_path = item.raw_path
            directory = _artifacts_dir(registry.files, item)
            import os
            from pathlib import Path

            raw_ok = bool(raw_path and await asyncio.to_thread(os.path.exists, raw_path))
            if not raw_ok:
                raise InvalidItemStateError(
                    "item has no raw media — run download first"
                )
            await purge_derived_media(item)
            item.status = ItemStatus.DOWNLOADED
            item.error = None
            item.error_class = ""
            await bump_item_seq(session, item)
            await session.merge(item)
            await session.commit()

        try:
            raw = Path(raw_path)
            result = await _asr_subtitles(
                ai, raw, directory, target_lang=subtitle_lang
            )
            if result is None:
                raise ProducerError(
                    "ASR unavailable — install with `uv sync --extra asr` "
                    "or configure xinference STT"
                )
            srt_path, zh_text = result

            burn = srt_path
            ffmpeg = find_ffmpeg()
            if await subtitles_filter_available(ffmpeg):
                try:
                    ass = srt_path.with_suffix(".ass")
                    await asyncio.to_thread(srt_to_ass, srt_path, ass)
                    burn = ass
                except Exception:  # noqa: BLE001 — subtitles are best-effort
                    pass

            out_path = directory / "final.mp4"
            edit = await compose_video(raw, None, burn, out_path, muted=False)
            try:
                cover = await generate_cover(raw, directory / "cover.jpg")
            except ProducerError:
                cover = None

            from backend.pipeline.phash import compute_phash

            phash = await compute_phash(str(out_path))

            async with session_factory() as session:
                row = await session.get(Item, item_id)
                if row is not None:
                    row.video_path = edit["path"]
                    row.subtitle_path = str(burn)
                    row.cover_path = cover["path"] if cover else None
                    row.audio_path = None
                    row.phash = phash
                    script = {
                        "mode": "retranslate",
                        "subtitle_zh": zh_text,
                        "source": "asr",
                    }
                    from backend.pipeline.package import generate_packaging

                    script = await generate_packaging(ai, row, script)
                    row.script_json = script
                    row.status = ItemStatus.QUEUED
                    row.error = None
                    row.error_class = ""
                    await bump_item_seq(session, row)
                    await session.merge(row)
                    await session.commit()
        except Exception as exc:  # noqa: BLE001 — 失败标 failed，产物尽力保留
            logger.exception("retranslate failed for item %s", item_id)
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                if row is not None:
                    row.status = ItemStatus.FAILED
                    row.error = str(exc)[:400]
                    row.error_class = "retranslate"
                    await session.merge(row)
                    await session.commit()
            raise RuntimeError(f"retranslate failed: {exc}") from exc

        self._emit(
            "item:" + item_id.hex,
            {"type": "item", "item_id": str(item_id), "status": "queued"},
        )
        return {"id": str(item_id), "status": "queued", "action": "retranslate"}

    # ---------- internals ----------

    async def _counts(self) -> dict[str, int]:
        """各状态计数快照（v0.3.5，job 前后 diff 用）。"""
        from sqlalchemy import func

        async with session_factory() as session:
            rows = await session.execute(
                select(Item.status, func.count()).group_by(Item.status)
            )
            return {str(status): count for status, count in rows.all()}

    async def _run_step(
        self, ctx: StepContext, job_name: str, *, limit: int, channel: str,
        input_statuses: tuple[str, ...] | None = None,
    ) -> dict:
        """执行单步骤。v0.11.10：input_statuses 覆盖透传给 _pending
        （绕过评分直接下载等宽松路径）；None = 按 step.input_statuses。"""
        if job_name == "collect":
            if self.collector is None:
                raise RuntimeError("no collector configured")
            # 采集源（v0.4 A4）：遍历配置源列表，逐源独立健康度/冷却；
            # channel 参数显式指定时只采该源（单源手动采集）
            sources = [channel] if channel else list(
                getattr(self.settings, "pipeline_sources", []) or ["hot"]
            )
            # 热点监控通道（v0.16）：开关开启时按独立间隔追加——rising 时效性
            # 高于普通采集节奏；节流状态存 engine 属性，与 auto_collect 解耦
            from backend.pipeline import watch as watch_mod

            watch_set: set[str] = set()
            if not channel:
                now_ts = datetime.now(UTC).timestamp()
                interval_s = int(
                    getattr(self.settings, "pipeline_watch_minutes", 15) or 15
                ) * 60
                last_w = getattr(self, "_last_watch_collect", 0.0)
                if watch_mod.watch_channels(self.settings) and now_ts - last_w >= interval_s:
                    self._last_watch_collect = now_ts
                    watch_channels = watch_mod.watch_channels(self.settings)
                    sources += [c for c in watch_channels if c not in sources]
                    watch_set = set(watch_channels)
                    ctx.log(f"[collect] watch channels={sorted(watch_set)}")
            ctx.log(f"[collect] sources={sources} limit={limit}")
            summaries: list[dict] = []
            for src in sources:
                cooldown_s = await self._collect_cooldown_left(
                    self.collector.name, src
                )
                if cooldown_s > 0:
                    ctx.log(f"[collect] {src} cooling down ({cooldown_s}s left)")
                    summaries.append({"channel": src, "cooldown_s": cooldown_s})
                    continue
                try:
                    summary = await run_collect(
                        ctx, src, limit, self.collector,
                        # watch 通道：三段词法预筛（v0.16）
                        filter_fn=(
                            watch_mod.predicate(self.settings)
                            if src in watch_set else None
                        ),
                    )
                except Exception as exc:  # noqa: BLE001 — 单源失败不中断其他源
                    logger.warning("collect %s failed: %s", src, exc)
                    await self._record_collect_failure(
                        self.collector.name, src, str(exc), exc
                    )
                    summaries.append({"channel": src, "error": str(exc)[:200]})
                    continue
                if summary.get("collected", 0) == 0:
                    # 接口正常但 0 条（v0.2.8）：源挂/被 block 返回空——健康度+冷却
                    await self._record_collect_empty(
                        self.collector.name, src, summary
                    )
                    summary["empty"] = True
                else:
                    await self._clear_collect_cooldown(
                        self.collector.name, src
                    )
                summaries.append(summary)
            total: dict = {
                "collected": sum(s.get("collected", 0) for s in summaries),
                "inserted": sum(s.get("inserted", 0) for s in summaries),
                "skipped": sum(s.get("skipped", 0) for s in summaries),
            }
            failed = [s for s in summaries if s.get("error")]
            cooling = [s for s in summaries if s.get("cooldown_s")]
            if failed:
                total["failed_sources"] = len(failed)
            if any(s.get("empty") for s in summaries):
                total["empty"] = True
            if cooling:
                total["cooldown_s"] = max(
                    c["cooldown_s"] for c in cooling
                )
            total["sources"] = summaries
            self._emit(ctx.run_id, {"type": "job_step", "step": "collect", **total})
            return total

        step_cls = get_step(job_name)
        step = step_cls()
        items = await self._pending(job_name, step, limit, statuses=input_statuses)
        ctx.log(f"[{job_name}] processing {len(items)} item(s)")
        self._emit(ctx.run_id, {"type": "job_step", "step": job_name, "count": len(items)})

        results = {"processed": len(items), "ok": 0, "rejected": 0, "failed": 0, "skipped": 0}
        for item in items:
            outcome = await self._process_item(ctx, step, item)
            results[outcome] += 1
        return results

    async def _pending(
        self, job_name: str, step: Pipe, limit: int,
        statuses: tuple[str, ...] | None = None,
    ) -> list[Item]:
        effective = statuses or step.input_statuses
        if not effective:
            return []
        async with session_factory() as session:
            result = await session.execute(
                select(Item)
                .where(Item.status.in_(effective))
                .order_by(Item.created_at.asc())
                .limit(limit)
            )
            return list(result.scalars().all())

    async def _process_item(self, ctx: StepContext, step: Pipe, item: Item) -> str:
        from backend.pipeline.helpers import bump_item_seq

        result: ProcessResult | None = None
        error = ""
        try:
            result = await step.process(ctx, item)
        except ItemCancelledError:
            # 协作式取消（wave11）：不标 failed——由调用方（produce_one）
            # 清理半成品并把条目回滚到可再制作状态
            raise
        except StepError as exc:
            error = str(exc)
        except Exception as exc:  # noqa: BLE001 — any crash fails the item
            logger.exception("step %s crashed for item %s", step.name, item.id)
            error = f"internal: {exc}"

        if result is None:
            outcome = "failed"
            new_status = ItemStatus.FAILED
        else:
            new_status = result.status
            outcome = (
                "skipped"  # v0.3.6：冷却/熔断等跳过，摘要不再误报「成功」
                if result.skip
                else "failed" if new_status == ItemStatus.FAILED else (
                    "rejected" if new_status == ItemStatus.REJECTED else "ok"
                )
            )

        async with session_factory() as session:
            row = await session.get(Item, item.id)
            if row is None:
                return outcome
            row.status = new_status
            if new_status == ItemStatus.FAILED:
                row.error = error or (result.error if result else None)
                # 失败分类（v0.2.1）：同类批量重试的数据基础
                row.error_class = classify_error(row.error or "", step.name)
            else:
                row.error = None
                row.error_class = ""
            for field, value in (result.data if result else {}).items():
                setattr(row, field, value)
            # v0.8.9：状态流转（评分/下载/制作等）= 最新入库序——最近活跃的
            # 条目在各列表「入库序」排序中排到最前（用户诉求：打回即最新入库）。
            # 冷却跳过（skip，未处理）不刷新——条目没有真实活动
            if outcome != "skipped":
                await bump_item_seq(session, row)
            await session.merge(row)
            await session.commit()

        self._emit(
            "item:" + item.id.hex,
            {
                "type": "item",
                "item_id": str(item.id),
                "step": step.name,
                "status": new_status,
                "error": error or None,
            },
        )
        return outcome

    async def _record_collect_empty(self, source: str, channel: str, summary: dict) -> None:
        """采集 0 条记账（v0.2.8）：源返回空列表视为异常——健康度失败计数 +
        10 分钟短冷却（连续 0 条叠加熔断逻辑），下次跳过避免空转。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    state = SourceState(source=source, channel=channel)
                    session.add(state)
                state.fail_count += 1
                state.consecutive_fails += 1
                state.last_error = (
                    f"collected 0 items (empty response, skipped={summary.get('skipped', 0)})"
                )
                state.last_error_at = datetime.now(UTC)
                cooldowns = state.get_cooldowns()
                cooldowns["default"] = datetime.now(UTC).timestamp() + 600  # 10 分钟
                state.set_cooldowns(cooldowns)
                await session.commit()
                logger.warning(
                    "collect %s:%s returned 0 items — cooldown 600s (consecutive %d)",
                    source, channel, state.consecutive_fails,
                )
        except Exception:  # noqa: BLE001 — 健康度记账失败不阻塞采集主流程
            logger.exception("failed to record empty collect for %s:%s", source, channel)

    async def _record_collect_failure(
        self, source: str, channel: str, error: str, exc: BaseException | None = None
    ) -> None:
        """采集失败记账（数据源健康度 v0.2.1）：连续失败 + 失败计数 + 最后错误 + 冷却。

        冰川式分类冷却（v0.8.6）：
        - CollectNetworkError（连接/超时）→ 900s：网络抖动不熔断，恢复后快速重试
        - CollectRateLimitedError（429）→ 1800s
        - CollectBlockedError（403）→ 1800s
        - 配置错误（无分类）→ 不冷却（改配置即可重试，避免「改配置→等 2h」）
        - 连续失败 ≥3（熔断）→ 翻倍到 2h
        """
        from backend.models.pipeline import SourceState
        from backend.pipeline.collectors.reddit import (
            CollectBlockedError,
            CollectNetworkError,
            CollectRateLimitedError,
        )

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    state = SourceState(source=source, channel=channel)
                    session.add(state)
                state.fail_count += 1
                state.consecutive_fails += 1
                state.last_error = str(error)[:500]
                state.last_error_at = datetime.now(UTC)
                if isinstance(exc, CollectNetworkError):
                    base_cooldown = 900
                elif isinstance(exc, (CollectRateLimitedError, CollectBlockedError)):
                    base_cooldown = 1800
                elif isinstance(exc, Exception):
                    base_cooldown = 0  # 配置类错误：不冷却，改配置即可重试
                else:
                    base_cooldown = 1800
                if base_cooldown > 0 and state.consecutive_fails >= 3:
                    base_cooldown = 7200  # 熔断（冰川式：持续失败翻倍）
                cooldown_s = base_cooldown
                cooldowns = state.get_cooldowns()
                if cooldown_s > 0:
                    cooldowns["default"] = datetime.now(UTC).timestamp() + cooldown_s
                else:
                    cooldowns.pop("default", None)
                state.set_cooldowns(cooldowns)
                await session.commit()
                logger.warning(
                    "collect %s:%s failed — cooldown %ds (consecutive %d)",
                    source, channel, cooldown_s, state.consecutive_fails,
                )
        except Exception:  # noqa: BLE001 — 健康度记账失败不阻塞采集主流程
            logger.exception("failed to record collect failure for %s:%s", source, channel)

    async def _collect_cooldown_left(self, source: str, channel: str) -> int:
        """冷却剩余秒数（>0 = 冷却中，跳过本轮采集）。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None:
                    return 0
                until = state.get_cooldowns().get("default", 0.0)
                left = int(until - datetime.now(UTC).timestamp())
                return max(left, 0)
        except Exception:  # noqa: BLE001 — 冷却查询失败按无冷却处理
            return 0

    async def _clear_collect_cooldown(self, source: str, channel: str) -> None:
        """采集成功 → 清除冷却（恢复即清零）。"""
        from backend.models.pipeline import SourceState

        try:
            async with session_factory() as session:
                state = (
                    await session.execute(
                        select(SourceState).where(
                            SourceState.source == source,
                            SourceState.channel == channel,
                        )
                    )
                ).scalar_one_or_none()
                if state is None or not state.get_cooldowns():
                    return
                state.set_cooldowns({})
                await session.commit()
        except Exception:  # noqa: BLE001 — 清除失败不影响主流程
            logger.exception("failed to clear cooldown for %s:%s", source, channel)

    def _emit(self, topic: str, event: dict) -> None:
        if self.hub is not None:
            self.hub.publish("pipeline", event)
            if topic:
                self.hub.publish(f"pipeline:{topic}", event)
