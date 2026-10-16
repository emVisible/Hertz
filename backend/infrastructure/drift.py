"""结构漂移比对：迁移产物 vs 模型元数据（v0.37，E1/E2 共用唯一实现）。

## 为什么有这个东西

测试库（``hertz_test``）schema 由 ``create_all`` 从**模型**重建，开发/线上库走
**alembic 迁移**——两条建 schema 路径各有一套真相源。「模型加了列、迁移没加」
这类漂移在测试里**永远绿**，只在真实库上炸 ORM 的 INSERT（v0.36 实测：
``layout_revisions`` 漏 ``updated_at``，快照 INSERT 带 ``RETURNING updated_at``，
工坊保存/删除全 500）。

## 口径：只报会在运行时炸的

结构类（事故）：``add_table`` / ``remove_table`` / ``add_column`` / ``remove_column``
——ORM 的 INSERT/UPDATE/SELECT 直接 UndefinedColumnError。

其余（噪音，只计数）：``modify_nullable`` / ``modify_type`` / ``modify_comment`` /
索引与约束反映差异——历史手写迁移与模型的口径差，不修不影响运行。
``alembic check`` 全量输出里绝大部分是这些噪音，人工看全量输出容易把真信号
埋掉（v0.36 就是这么漏的），所以守卫测试与 CLI 都按此口径过滤。
"""

from __future__ import annotations

import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy.ext.asyncio import create_async_engine

from backend.infrastructure import migration_guard
from backend.models import Base

logger = logging.getLogger(__name__)

# 会在运行时炸 ORM 的漂移类别：模型声明的列/表必须在库里存在（或显式不要）。
STRUCTURAL_KINDS = frozenset(
    {"add_table", "remove_table", "add_column", "remove_column"}
)


@dataclass
class DriftReport:
    """一次比对的结果。

    ``structural``：可读描述列表，空 = 干净。
    ``informational``：反映噪音的类别计数，不参与成败判定。
    """

    structural: list[str] = field(default_factory=list)
    informational: Counter = field(default_factory=Counter)
    total: int = 0

    @property
    def ok(self) -> bool:
        return not self.structural


async def compare_database(url: str) -> DriftReport:
    """对 ``url`` 指定的库跑一次 autogenerate 比对（只读，自带 engine 生命周期）。

    比对视角是**模型**：``add_column`` = 模型有、库里没有（新库会缺列，
    ORM 会炸）；``remove_column`` = 库里有、模型没有。
    """
    engine = create_async_engine(url)
    try:
        raw: list[Any] = []

        def _compare(sync_conn) -> None:
            mc = MigrationContext.configure(
                sync_conn,
                opts={"include_object": migration_guard.include_object},
            )
            raw.extend(compare_metadata(mc, Base.metadata))

        async with engine.connect() as conn:
            await conn.run_sync(_compare)
    finally:
        await engine.dispose()
    return _classify(raw)


def _classify(raw: list[Any]) -> DriftReport:
    report = DriftReport(total=len(raw))
    for diff in raw:
        diff = _unwrap(diff)
        kind = _diff_kind(diff)
        if kind is None:
            continue
        if kind in STRUCTURAL_KINDS:
            report.structural.append(_describe_structural(diff))
        else:
            report.informational[kind] += 1
    return report


def _unwrap(diff: Any) -> Any:
    """把套了一层 list 的 diff 还原成 tuple（见 _diff_kind 的两种形状说明）。"""
    if isinstance(diff, list) and len(diff) == 1 and isinstance(diff[0], tuple):
        return diff[0]
    return diff


def _diff_kind(diff: Any) -> str | None:
    """取出 diff 的类别名。

    alembic 的比对结果有两种形状：结构类（add_column 等）是裸 tuple；
    列级噪音（modify_nullable 等）是**套了一层 list 的 tuple**
    （第 5 位带元数据 dict）。两种都要认，否则噪音计数会漏掉一半。
    """
    if isinstance(diff, tuple) and diff:
        return str(diff[0])
    return None


def _describe_structural(diff: tuple) -> str:
    kind = diff[0]
    if kind in ("add_table", "remove_table"):
        return f"{kind}: {diff[1]}"
    if kind == "add_column":
        return (
            f"add_column: {diff[2]}.{_col_name(diff[3])}"
            "（模型有、库里没有——新库缺列，ORM 运行时会炸）"
        )
    if kind == "remove_column":
        return f"remove_column: {diff[2]}.{_col_name(diff[3])}（库里有、模型没有）"
    return str(diff)


def _col_name(col: Any) -> str:
    return getattr(col, "name", str(col))
