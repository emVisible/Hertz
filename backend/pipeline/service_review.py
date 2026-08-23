"""PipelineService 审核与预处理域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory

logger = logging.getLogger(__name__)



class ReviewMixin:
    PRODUCE_MODULES = ("passthrough", "voice", "subtitle", "translate", "mute")

    # ---------- review ----------

    async def approve(self, item_id: uuid.UUID) -> dict:
        return await self.engine.approve(item_id)

    async def reject(self, item_id: uuid.UUID, reason: str = "") -> dict:
        return await self.engine.reject(item_id, reason)

    async def retry(self, item_id: uuid.UUID) -> dict:
        return await self.engine.retry(item_id)

    async def requeue(self, item_id: uuid.UUID) -> dict:
        return await self.engine.requeue(item_id)

    async def retranslate(self, item_id: uuid.UUID) -> dict:
        return await self.engine.retranslate(item_id)

    async def batch_action(
        self, action: str, ids: list[uuid.UUID]
    ) -> dict:
        """批量审核操作（v0.4 A2）：逐条走现有引擎方法，单条失败不中断。

        action: approve | reject | back_to_prep | back_to_collect | requeue
        """
        from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError

        actions = {"approve", "reject", "back_to_prep", "back_to_collect", "requeue"}
        if action not in actions:
            raise ValueError(f"unknown batch action: {action}")

        ok, failed = 0, []
        for item_id in ids:
            try:
                if action == "approve":
                    await self.approve(item_id)
                elif action == "reject":
                    await self.reject(item_id)
                elif action == "back_to_prep":
                    await self.back_to_prep(item_id)
                elif action == "back_to_collect":
                    await self.back_to_collect(item_id)
                else:
                    await self.requeue(item_id)
                ok += 1
            except (InvalidItemStateError, ItemNotFoundError) as exc:
                failed.append({"id": str(item_id), "error": str(exc)})
        return {"ok": ok, "failed": failed}

    # ---------- 生产方式（v0.3.3，预处理人工选择） ----------

    PRODUCE_MODULES = ("passthrough", "voice", "subtitle", "translate", "mute")

    @staticmethod
    def normalize_produce_options(raw: dict) -> dict:
        """模块集合归一化：只保留合法模块布尔；直发与其他互斥（直发优先）。"""
        options = {
            m: bool(raw.get(m)) for m in ReviewMixin.PRODUCE_MODULES
        }
        if options["passthrough"]:
            for m in ("voice", "subtitle", "translate", "mute"):
                if m != "passthrough":
                    options[m] = False
        # 翻译依赖字幕：选翻译自动附带字幕
        if options["translate"]:
            options["subtitle"] = True
        return options

    async def set_produce_options(self, item_ids: list[uuid.UUID], raw: dict) -> int:
        """设置生产方式（单条或批量）：互斥校验 + 翻译附带字幕。"""
        options = self.normalize_produce_options(raw)
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item).where(Item.id.in_(item_ids))
                )
            ).scalars().all()
            for row in rows:
                row.produce_options = options
            await session.commit()
            return len(rows)

    # ---------- 相邻双向（v0.3.9 流程解耦） ----------
    #
    # 采集 ⇄ 预处理 ⇄ 审核 ⇄ 发布：只允许与相邻环节互相打回，职责单一。
    # 审核只负责 通过/拒绝/打回预处理；预处理负责 制作/评分/拒绝/打回采集；
    # 发布负责 发布/打回审核。

    async def act_by_id(self, item_id: uuid.UUID, action: str) -> dict:
        """按 id 执行审核动作（v0.18 Telegram bot 回调入口）——与桌面端
        审核完全同源（同一闸门，不同入口）。action 白名单三选一。"""
        if action == "approve":
            return await self.approve(item_id)
        if action == "reject":
            return await self.reject(item_id)
        if action == "back_to_prep":
            return await self.back_to_prep(item_id)
        raise ValueError(f"unknown review action: {action}")

    async def back_to_prep(self, item_id: uuid.UUID) -> dict:
        """审核打回预处理（v0.3.9）：queued → downloaded（v0.8.6 评分先行语义）。

        不清除任何产物（成片/封面/字幕保留）——回到预处理后仍可
        预览播放，是否重制由预处理侧决定；重制时 produce 覆盖产物。
        脚本保留（不强制重新生成）。
        """
        from backend.pipeline.helpers import load_item_for_action, purge_derived_media

        async with session_factory() as session:
            item = await load_item_for_action(
                item_id, (ItemStatus.QUEUED,), "back-to-prep"
            )
            # v0.8.9 对齐原项目 reproduce：打回即 purge 派生媒体（删旧成片文件、
            # 清字段与旁白缓存）——预处理器/审核侧立即看不到旧成片，重制必然全新
            await purge_derived_media(item)
            item.status = ItemStatus.DOWNLOADED
            item.error = None
            item.error_class = ""
            from backend.pipeline.helpers import bump_item_seq

            await bump_item_seq(session, item)  # v0.8.9：打回预处理 = 最新入库序
            await session.merge(item)
            await session.commit()
        self.hub.publish(
            "pipeline",
            {
                "type": "item",
                "item_id": str(item_id),
                "status": "downloaded",
                "step": "back_to_prep",
            },
        )
        return {"id": str(item_id), "status": "downloaded"}

    async def back_to_collect(self, item_id: uuid.UUID) -> dict:
        """预处理打回采集（v0.3.9）：downloaded/scored → discovered（v0.8.6 语义）。

        scored=已评分未下载 / downloaded=已下载未加工——重新走下载或评分。
        """
        from backend.pipeline.helpers import load_item_for_action, purge_derived_media

        async with session_factory() as session:
            item = await load_item_for_action(
                item_id, (ItemStatus.DOWNLOADED, ItemStatus.SCORED), "back-to-collect"
            )
            await purge_derived_media(item)  # v0.8.9：打回采集同样清除派生媒体
            item.status = ItemStatus.DISCOVERED
            item.error = None
            item.error_class = ""
            from backend.pipeline.helpers import bump_item_seq

            await bump_item_seq(session, item)  # v0.8.9：打回采集 = 最新入库序
            await session.merge(item)
            await session.commit()
        self.hub.publish(
            "pipeline",
            {
                "type": "item",
                "item_id": str(item_id),
                "status": "discovered",
                "step": "back_to_collect",
            },
        )
        return {"id": str(item_id), "status": "discovered"}
