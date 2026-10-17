"""启动期"愈合"不许被一条坏数据连坐（2026-10-17 加）。

## 这条判据为什么长这样

现象（真实日志）：`_heal_legacy_plans()` 的 `try/except` 写在 **for 循环外**，
于是库里只要有一条 `phase_order == []` 的旧计划，整个愈合流程每次启动都抛
`InvalidPlanError` 并中止。后果有两个，第二个才是致命的：

1. 那条坏计划永远修不好；
2. **每一次后端启动都刷一条完整 traceback**——而那条启动日志里同时写着
   2806 次启停、峰值 8 次/秒的重启风暴，1320 条 traceback 就是风暴的一部分。

所以判据不只盯"别抛异常"，还要盯"**一条 traceback 都不许有**"：
用 `caplog` 断言没有 `exc_info` 的记录——`logger.exception` 是重灾区，
它每次启动都留一条带栈的记录，正是把日志撑到 4.4MB 的那一位。
"""

from __future__ import annotations

import logging
import uuid

import pytest

from backend.infrastructure.logging import log_manager
from backend.main import _heal_legacy_plans
from backend.models.plan import Plan
from backend.models.session import session_factory

pytestmark = pytest.mark.asyncio

# 一条"好"的旧计划：带已删除的历史 key（growth_director），应被折叠成现行 key
LEGACY_ORDER = [{"key": "growth_director", "enabled": True}]
# 一条坏计划：空 phase_order。修复前它会让整批愈合抛异常并中止
BROKEN_ORDER: list = []


async def _clear_plans() -> None:
    async with session_factory() as session:
        for plan in (await session.execute(Plan.__table__.select())).all():
            await session.execute(Plan.__table__.delete().where(Plan.__table__.c.id == plan.id))
        await session.commit()


async def _add(name: str, phase_order: list) -> str:
    async with session_factory() as session:
        plan = Plan(id=uuid.uuid4(), name=name, phase_order=phase_order)
        session.add(plan)
        await session.commit()
        return str(plan.id)


async def _get(plan_id: str) -> list:
    async with session_factory() as session:
        plan = await session.get(Plan, uuid.UUID(plan_id))
        return list(plan.phase_order) if plan else []


async def _delete(plan_id: str) -> None:
    async with session_factory() as session:
        await session.execute(
            Plan.__table__.delete().where(Plan.__table__.c.id == uuid.UUID(plan_id))
        )
        await session.commit()


async def test_broken_plan_does_not_block_healing_of_the_others() -> None:
    """核心：一条坏计划不许让其余计划修不好。"""
    good = await _add(f"good-{uuid.uuid4().hex[:6]}", list(LEGACY_ORDER))
    bad = await _add(f"bad-{uuid.uuid4().hex[:6]}", list(BROKEN_ORDER))
    try:
        await _heal_legacy_plans()
        # 好计划被修复（growth_director → distribution）
        assert await _get(good) != list(LEGACY_ORDER)
        # 坏计划**不被自动改写**：空 phase_order 是要人工判断的语义问题，
        # 静默补全会掩盖真正的数据损坏
        assert await _get(bad) == []
    finally:
        await _delete(good)
        await _delete(bad)


async def test_broken_plan_emits_no_traceback(caplog: pytest.LogCaptureFixture) -> None:
    """一条 traceback 都不许有——风暴期间它就是日志膨胀的来源。"""
    bad = await _add(f"bad-{uuid.uuid4().hex[:6]}", list(BROKEN_ORDER))
    logger = log_manager.get()
    with caplog.at_level(logging.DEBUG, logger=logger.name):
        try:
            await _heal_legacy_plans()
            records = [r for r in caplog.records if r.name == logger.name]
            tracebacks = [r for r in records if r.exc_info]
            assert tracebacks == [], f"启动期刷出了 traceback：{tracebacks}"
            # 被点名报出来（一次汇总，不逐条刷屏）
            warned = [r for r in records if r.levelno >= logging.WARNING]
            assert any("invalid phase_order" in r.getMessage() for r in warned)
        finally:
            await _delete(bad)


async def test_all_plans_healthy_is_quiet(caplog: pytest.LogCaptureFixture) -> None:
    """没有坏数据时不该有任何噪音（零噪声纪律，与诊断横幅同）。"""
    good = await _add(f"good-{uuid.uuid4().hex[:6]}", list(LEGACY_ORDER))
    logger = log_manager.get()
    with caplog.at_level(logging.DEBUG, logger=logger.name):
        try:
            await _heal_legacy_plans()
            warned = [
                r
                for r in caplog.records
                if r.name == logger.name and r.levelno >= logging.WARNING
            ]
            assert warned == [], f"库是干净的却仍有告警：{[w.getMessage() for w in warned]}"
        finally:
            await _delete(good)


async def test_out_of_table_exception_still_does_not_break_startup() -> None:
    """外层 except 保留：表都不在了也不能让启动崩（这是它原本的职责）。"""
    import backend.main as main_mod

    class _Boom:
        def __getattr__(self, _name: str):
            raise RuntimeError("db gone")

    original = main_mod.select
    main_mod.select = lambda *a, **k: _Boom()  # type: ignore[assignment]
    try:
        await _heal_legacy_plans()  # 不抛即通过
    finally:
        main_mod.select = original  # type: ignore[assignment]