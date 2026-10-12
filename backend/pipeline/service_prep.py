"""预处理单条操作域（v0.22.x 自 PublishMixin 迁出）：评分/下载/制作单条与取消回滚。"""

import logging
import uuid

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.errors import ItemNotFoundError

logger = logging.getLogger(__name__)

logger = logging.getLogger(__name__)


class PrepOpsMixin:
    async def score_one(self, item_id: uuid.UUID) -> dict:
        """单条评分（v0.3.5，预处理手动评分按钮）：v0.8.6 评分先行——仅未评分条目。"""
        from backend.pipeline.errors import InvalidItemStateError

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status != ItemStatus.DISCOVERED:
                raise InvalidItemStateError(
                    f"cannot score item in state {item.status}"
                )
        outcome = await self.engine.process_one("score", item_id)
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "score failed"
            raise RuntimeError(error)
        return {"id": str(item_id), "status": "scored", "outcome": outcome}

    async def download_one(self, item_id: uuid.UUID, skip_score: bool = False) -> dict:
        """单条下载（v0.8.6 评分先行，预处理手动下载按钮）：默认仅已评分未下载
        条目。v0.11.10：skip_score=True 放行 discovered——省 API 余额场景绕过评分
        直接下载（审核以人工判断为主，评分为辅助信号）。"""
        from backend.pipeline.errors import InvalidItemStateError

        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            # 双道校验同步放宽：service 层 + engine.process_one（status 为
            # String 列读回 str，engine 层按字符串元组比较）
            allowed = ("discovered", "scored") if skip_score else ("scored",)
            if item.status not in allowed:
                raise InvalidItemStateError(
                    f"cannot download item in state {item.status}"
                )
        outcome = await self.engine.process_one(
            "download", item_id,
            input_statuses=allowed if skip_score else None,
        )
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "download failed"
            raise RuntimeError(error)
        # 状态以库为准：冷却/熔断/隔离跳过时条目仍是 discovered，回一个硬编码的
        # "downloaded" 等于对界面撒谎——用户照这句话去「已下载未加工」找，必然是空的。
        # 引擎才是状态流转的唯一作者（base.py 契约），这里只如实转述。
        async with session_factory() as session:
            row = await session.get(Item, item_id)
            status = row.status if row is not None else "discovered"
        return {"id": str(item_id), "status": str(status), "outcome": outcome}

    async def download_unscored(self, limit: int = 10) -> dict:
        """批量直下（v0.11.10，预处理「直接下载」按钮）：对全部未评分
        （discovered）条目执行下载，跳过评分环节——API 余额不足时省着用。
        复用 single-flight 队列（运行中 409）。"""
        return await self.run_batch(
            "download", limit=limit, input_statuses=("discovered",)
        )

    async def produce_one(self, item_id: uuid.UUID) -> dict:
        """单条制作（v0.3.4，预处理「制作」按钮）：v0.8.6 评分先行语义——
        produce 吃 downloaded（已下载未加工）；discovered 一键制作自动转入
        downloaded（跳过评分/下载，宽松快捷路径）。

        wave11 取消制作：开始前清除陈旧取消标志；产线检查点命中抛
        ItemCancelledError → 清理半成品回滚 downloaded，不标 failed。
        """
        from backend.pipeline.cancel import ItemCancelledError, clear_cancel
        from backend.pipeline.errors import InvalidItemStateError

        clear_cancel(item_id)
        async with session_factory() as session:
            item = await session.get(Item, item_id)
            if item is None:
                raise ItemNotFoundError(item_id)
            if item.status not in (ItemStatus.DISCOVERED, ItemStatus.DOWNLOADED):
                raise InvalidItemStateError(
                    f"cannot produce item in state {item.status}"
                )
            # 「没有 raw」不等于「没下载」——合集条目（v0.35）天生就没有 raw_path，
            # 它的成片由 clips 现场装配出来。此前这里只放行 text_only，于是**任何
            # 合集都产不出来**，报的还是「item not downloaded yet — run download
            # first」：一个关于合集持有者的、彻底误导的结论（合集根本不需要下载）。
            #
            # 判据是「有没有 clips」而不是「item_type 是不是 video_raw」——
            # 合集的 item_type 就是 video_raw（产物确实是视频），靠类型判断必然漏。
            if not item.raw_path and not item.clips and (item.item_type or "") != "text_only":
                raise InvalidItemStateError(
                    "item not downloaded yet — run download first"
                )
            if item.status != ItemStatus.DOWNLOADED:
                item.status = ItemStatus.DOWNLOADED
                await session.commit()
        try:
            outcome = await self.engine.process_one("produce", item_id)
        except ItemCancelledError:
            # wave11：用户取消 → 清理半成品派生媒体，条目回 downloaded 干净态
            await self._rollback_cancelled_produce(item_id)
            return {"id": str(item_id), "status": "cancelled", "outcome": "cancelled"}
        finally:
            clear_cancel(item_id)
        if outcome == "failed":
            async with session_factory() as session:
                row = await session.get(Item, item_id)
                error = row.error if row is not None else "produce failed"
            raise RuntimeError(error)
        return {"id": str(item_id), "status": "queued", "outcome": outcome}

    async def _rollback_cancelled_produce(self, item_id: uuid.UUID) -> None:
        """取消制作收尾（wave11）：条目回滚到 downloaded 可再制作态。

        清理半成品（final.mp4/narration.mp3/subs/cover 等派生媒体），保留
        raw 源片；script_json 保留用户手动改过的发布元数据（purge 语义）。
        """
        from backend.pipeline.helpers import purge_derived_media

        async with session_factory() as session:
            row = await session.get(Item, item_id)
            if row is None:
                return
            await purge_derived_media(row)
            row.status = ItemStatus.DOWNLOADED
            row.error = None
            row.error_class = ""
            await session.merge(row)
            await session.commit()
        self.engine._emit(
            "item:" + item_id.hex,
            {"type": "item", "item_id": str(item_id), "status": "downloaded",
             "error": "cancelled"},
        )

    async def produce_cancel(self, item_id: uuid.UUID) -> dict:
        """取消单条制作（wave11）：置位协作取消标志——产线下一检查点
        （阶段间 / ffmpeg 0.25s 轮询）命中即中止，条目回滚 downloaded。
        """
        from backend.pipeline.cancel import request_cancel

        request_cancel(item_id)
        return {"ok": True, "cancelling": True}

    async def set_priority(self, ordered_ids: list[uuid.UUID]) -> dict:
        """制作优先级落库（v0.26 运营面板）：按给定顺序赋 priority。

        首位最高（len），末位 1；不在列表中的条目不动（不清零——
        避免全量重排误伤他人设定的优先级）。
        """
        if not ordered_ids:
            raise ValueError("ordered_ids 必填")
        if len(ordered_ids) > 200:
            raise ValueError("单批最多 200 条")
        n = len(ordered_ids)
        updated = 0
        async with session_factory() as session:
            for i, item_id in enumerate(ordered_ids):
                row = await session.get(Item, item_id)
                if row is None:
                    continue
                row.priority = n - i
                updated += 1
            await session.commit()
        return {"updated": updated}

