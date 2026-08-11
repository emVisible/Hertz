"""内置数据 seed 通用工具（v0.8）：消除 5+ 处同构 seed 骨架。

语义（AXIOM §1.2 单一真相源）：内置以代码为准——
- sync 字段列表：已有内置行同步更新（扩写升级立即生效）
- sync=None：只插入不覆盖（用户改过内置也尊重）
- 用户自定义行（非内置锚）不受影响
"""

import logging

from sqlalchemy import select

from backend.models.base import BaseModel
from backend.models.session import session_factory

logger = logging.getLogger(__name__)


async def builtin_seed(
    model: type[BaseModel],
    builtins: list[dict],
    *,
    key_field: str,
    sync: list[str] | None = None,
    sort: bool = True,
    builtin_only: bool = False,
    log_name: str,
) -> int:
    """按 key_field 锚定 seed 内置行；返回变更数。

    builtin_only=True：只同步 builtin 标记的行（用户自定义同锚行不覆盖）。
    """
    async with session_factory() as session:
        rows = (await session.execute(select(model))).scalars().all()
        by_key = {getattr(r, key_field): r for r in rows}
        changed = 0
        for order, item in enumerate(builtins):
            anchor = item[key_field]
            row = by_key.get(anchor)
            if row is None:
                fields = {k: v for k, v in item.items() if k != key_field}
                if sort and "sort_order" not in fields:
                    fields["sort_order"] = order
                session.add(model(**{key_field: anchor, **fields}))
                changed += 1
                continue
            if sync and (not builtin_only or getattr(row, "builtin", False)):
                dirty = False
                for field in sync:
                    if field == "sort_order" and sort:
                        value = order
                    else:
                        value = item.get(field)
                    if value is not None and getattr(row, field) != value:
                        setattr(row, field, value)
                        dirty = True
                if dirty:
                    changed += 1
        if changed:
            await session.commit()
            logger.info("synced %d builtin %s", changed, log_name)
        return changed
