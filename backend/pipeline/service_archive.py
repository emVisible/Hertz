"""PipelineService 归档与备用库域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid

from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory

logger = logging.getLogger(__name__)



class ArchiveMixin:
    # ---------- 归档 / 备用库（wave10：删除入口收口异常区） ----------

    # 归档清洗保留的脚本键（发布元数据；旁白/字幕等重制缓存删除）
    _ARCHIVE_KEEP_SCRIPT_KEYS = (
        "bili_title", "bili_desc", "bili_tags", "bili_tid", "bili_copyright",
    )

    async def archive(self, ids: list[uuid.UUID]) -> dict:
        """归档（批量）：磁盘清理 + 字段清洗 + 标记 archived。

        仅终态（published/approved/failed/rejected）可归档——流程中条目
        不提供归档入口；单条失败不中断。数据保留基础字段（标题/来源/评分/
        发布记录）作备用库，磁盘资源全部删除。"""
        from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError
        from backend.pipeline.helpers import clear_item_disk

        ok, failed = 0, []
        for item_id in ids:
            try:
                async with session_factory() as session:
                    item = await session.get(Item, item_id)
                    if item is None:
                        raise ItemNotFoundError(item_id)
                    if item.archived:
                        raise InvalidItemStateError("item already archived")
                    if item.status not in (
                        ItemStatus.APPROVED, ItemStatus.PUBLISHED,
                        ItemStatus.REJECTED, ItemStatus.FAILED,
                    ):
                        raise InvalidItemStateError(
                            f"cannot archive item in state {item.status}"
                        )
                    await clear_item_disk(item)
                    if item.script_json:
                        item.script_json = {
                            k: v for k, v in (item.script_json or {}).items()
                            if k in self._ARCHIVE_KEEP_SCRIPT_KEYS
                        } or None
                    item.scheduled_at = None
                    item.queue_phase = ""
                    item.archived = True
                    await session.commit()
                ok += 1
            except (InvalidItemStateError, ItemNotFoundError) as exc:
                failed.append({"id": str(item_id), "error": str(exc)})
        return {"ok": ok, "failed": failed}

    async def unarchive(self, ids: list[uuid.UUID]) -> dict:
        """恢复（批量）：清除 archived 标记回到原状态列表。

        磁盘资源已删，重制/重新下载自动生成；单条失败不中断。"""
        from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError

        ok, failed = 0, []
        for item_id in ids:
            try:
                async with session_factory() as session:
                    item = await session.get(Item, item_id)
                    if item is None:
                        raise ItemNotFoundError(item_id)
                    if not item.archived:
                        raise InvalidItemStateError("item is not archived")
                    item.archived = False
                    await session.commit()
                ok += 1
            except (InvalidItemStateError, ItemNotFoundError) as exc:
                failed.append({"id": str(item_id), "error": str(exc)})
        return {"ok": ok, "failed": failed}

    async def purge(self, ids: list[uuid.UUID]) -> dict:
        """彻底删除（批量，不可逆）：物理删行。

        仅归档条目可彻底删除（已清磁盘的二次确认语义）；删行前 best-effort
        再清一次磁盘（恢复后重新下载的文件兜底）；单条失败不中断。"""
        from backend.pipeline.errors import InvalidItemStateError, ItemNotFoundError
        from backend.pipeline.helpers import clear_item_disk

        ok, failed = 0, []
        for item_id in ids:
            try:
                async with session_factory() as session:
                    item = await session.get(Item, item_id)
                    if item is None:
                        raise ItemNotFoundError(item_id)
                    if not item.archived:
                        raise InvalidItemStateError(
                            "only archived items can be purged — archive first"
                        )
                    await clear_item_disk(item)
                    await session.delete(item)
                    await session.commit()
                ok += 1
            except (InvalidItemStateError, ItemNotFoundError) as exc:
                failed.append({"id": str(item_id), "error": str(exc)})
        return {"ok": ok, "failed": failed}

    async def archived_items(self, limit: int = 200) -> list[dict]:
        """备用库（wave10）：archived 条目列表，seq desc 有界。"""
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item)
                    .where(Item.archived.is_(True))
                    .order_by(Item.seq.desc().nulls_last())
                    .limit(limit)
                )
            ).scalars().all()
            return [self._serialize(i) for i in rows]
