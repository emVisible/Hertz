"""alembic autogenerate 数据保护闸（v0.32 S1，见 docs/PLAN_V040.md）。

存在理由：`uv run alembic check` 当前会报 **2 个 remove_table**
（`messages` / `conversations`——wave5 遗留表，模型侧早已删除但库里带着用户历史数据）。
任何一次「顺手清漂移」的 `alembic revision --autogenerate` 都会把它们写成
`op.drop_table(...)`，升级即**不可逆丢数据**。这里把「删表」从自动生成结果里摘掉，
并让模型不再拥有的历史表根本不参与比对。

删除仍然可以做，只是必须显式：设 `HERTZ_ALLOW_DROP_TABLE=1` 再生成。
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from typing import Any

from alembic.operations import ops as alembic_ops

logger = logging.getLogger(__name__)

ALLOW_DROP_ENV = "HERTZ_ALLOW_DROP_TABLE"

# 模型侧已无定义、但库里仍带用户数据的历史表：不参与 autogenerate 比对。
# 要真正删除它们，请写一次显式迁移（并先确认数据可弃）。
LEGACY_UNOWNED_TABLES = frozenset({"messages", "conversations"})


def drop_allowed() -> bool:
    """显式开关：只有 HERTZ_ALLOW_DROP_TABLE=1 才允许自动生成删表。"""
    return os.environ.get(ALLOW_DROP_ENV, "").strip() == "1"


def include_object(obj: Any, name: str, type_: str, reflected: bool, compare_to: Any) -> bool:  # noqa: ARG001
    """alembic `include_object` 回调：滤掉 legacy 表的「库里有、模型没有」比对。

    与 `strip_destructive_ops` 共用同一个放行开关——否则 `ALLOW_DROP_ENV` 对这两张
    表就是句假话（表根本不进比对，后面的摘除层永远轮不到执行）。实测验证过：
    不设开关时 `alembic check` 的 remove_table 由 2 变 0，设 `=1` 时回到 2。
    """
    if (
        type_ == "table"
        and reflected
        and compare_to is None
        and name in LEGACY_UNOWNED_TABLES
        and not drop_allowed()
    ):
        logger.info("alembic 闸：跳过历史表 %s 的删除建议（模型侧无定义）", name)
        return False
    return True


def strip_destructive_ops(operations: Sequence, *, allow_drop: bool | None = None) -> list[str]:
    """就地移除 `DropTableOp`，返回被移除的表名（供调用方告警）。

    `operations` 是 alembic 的 UpgradeOps.ops 列表。默认** always 滤除**，
    除非显式允许（参数或环境变量）。"""
    if allow_drop is None:
        allow_drop = drop_allowed()
    if allow_drop:
        return []
    removed: list[str] = []
    for op in list(operations):
        if isinstance(op, alembic_ops.DropTableOp):
            operations.remove(op)
            removed.append(getattr(op, "table_name", "?"))
    if removed:
        logger.warning(
            "alembic 闸：已丢弃自动生成的删表建议 %s（不可逆操作需显式："
            "设 %s=1 或手写迁移）",
            removed,
            ALLOW_DROP_ENV,
        )
    return removed


def process_revision_directives(context, revision, directives) -> None:  # noqa: ARG001
    """接进 `context.configure(process_revision_directives=...)`。

    alembic 传进来的 `directives[0]` 是 `MigrationScript`，ops 挂在它的
    `.upgrade_ops.ops` 上——直接当 ops 列表用会 AttributeError，等于把
    `alembic check` 与 `revision --autogenerate` 全部跑崩（本文件第一版就是这么坏的）。
    因此这里按形状取，且遇到不认识的 directive 只跳过、不抛。
    """
    for directive in directives:
        upgrade_ops = getattr(directive, "upgrade_ops", None)
        inner = getattr(upgrade_ops, "ops", None)
        if inner is None:
            continue
        strip_destructive_ops(inner)
