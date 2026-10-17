"""Hertz FastAPI application entry point.

Lifecycle: initialize ServiceRegistry (providers), start scheduler on
startup; shut both down cleanly on exit.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from backend.config import APP_VERSION, settings
from backend.factory.registry import ServiceRegistry
from backend.infrastructure.errors import register_exception_handlers
from backend.infrastructure.logging import log_manager
from backend.models.crew import Crew
from backend.models.plan import Plan
from backend.models.session import session_factory
from backend.orchestration.errors import InvalidPlanError
from backend.orchestration.phases import LEGACY_PHASE_ALIASES, PHASE_INDEX
from backend.orchestration.plans import PlanService
from backend.routers import api_router


async def _heal_legacy_plans() -> None:
    """启动时把旧计划里已移除/历史工序归一化并存回（wave7 精简的一次性愈合）。

    老计划仍存着 preflight/scout/image_gen/quality_gate 等已删除 key，
    若不愈合，UI 会显示已废弃的旧工序、运行日志会刷"工序已移除"跳过行。
    别名折叠（growth_director→distribution 等）+ 剔除空别名，只留现行工序。

    **坏数据不许连坐**：一条 `phase_order` 为空的旧计划曾让整批愈合抛异常
    并中止——外层 except 拦得住崩溃，却让**其余计划永远修不好**，而且每次启动
    都刷一条完整 traceback（实测一次会话 1320 条，日志直接涨到 4.4MB）。
    所以校验放在**循环内**：单条非法 → 计数跳过，一条 traceback 都不打。
    不自动改写这类数据（空 phase_order 是要人工判断的语义问题，静默补全会
    掩盖真正的数据损坏），只把它点名报出来。
    """
    try:
        async with session_factory() as session:
            rows = (await session.execute(select(Plan))).scalars().all()
            healed = 0
            skipped: list[tuple[str, str]] = []
            for plan in rows:
                try:
                    cleaned = PlanService.validate_phase_order(plan.phase_order)
                except InvalidPlanError as exc:
                    skipped.append((str(plan.id), exc.args[0] if exc.args else "invalid"))
                    continue
                if cleaned is not None and cleaned != plan.phase_order:
                    plan.phase_order = cleaned
                    healed += 1
            if healed:
                await session.commit()
                log_manager.get().info("healed %d legacy plan(s) phase_order", healed)
            if skipped:
                # 只报一次汇总，不逐条刷屏：这些行需要人来决定怎么处理
                log_manager.get().warning(
                    "skipped %d plan(s) with invalid phase_order（需人工处理，未自动改写）: %s",
                    len(skipped),
                    ", ".join(f"{pid}:{reason}" for pid, reason in skipped[:5]),
                )
    except Exception:  # noqa: BLE001 — 启动不因愈合失败而中断
        log_manager.get().exception("failed to heal legacy plans")


def _resolve_agent_key(key: str) -> str | None:
    """团队 agent key → 现行工序 key（同计划归一化规则，空别名剔除）。"""
    if key in PHASE_INDEX:
        return key
    return LEGACY_PHASE_ALIASES.get(key) or None


async def _heal_legacy_crews() -> None:
    """启动时把团队里已移除/历史 agent key 折叠到现行 5 角色。

    老团队存着 scout/analyst/growth_director 等旧 key（wave7 精简前创建），
    引擎只认现行 key（director/writer/visual_director/editor/distribution），
    不愈合则团队形同虚设（UI 显示旧成员、运行回退默认）。
    """
    try:
        async with session_factory() as session:
            rows = (await session.execute(select(Crew))).scalars().all()
            healed = 0
            for crew in rows:
                cleaned: list[str] = []
                seen: set[str] = set()
                for agent in crew.agents or []:
                    # v4.0 起 agents 是角色 key 字符串列表；兼容旧 dict 格式
                    if isinstance(agent, str):
                        key = _resolve_agent_key(agent)
                    else:
                        key = _resolve_agent_key(str(agent.get("key") or ""))
                    if key is None or key in seen:
                        continue
                    seen.add(key)
                    cleaned.append(key)
                if cleaned and cleaned != crew.agents:
                    crew.agents = cleaned
                    healed += 1
            if healed:
                await session.commit()
                log_manager.get().info("healed %d legacy crew(s) agents", healed)
    except Exception:  # noqa: BLE001 — 启动不因愈合失败而中断
        log_manager.get().exception("failed to heal legacy crews")


@asynccontextmanager
async def lifespan(_: FastAPI):
    import time

    _t0 = time.perf_counter()
    log_manager.get().info(f"Hertz backend starting (v{APP_VERSION})")
    registry = ServiceRegistry.get()
    registry.initialize(settings)
    _t1 = time.perf_counter()
    # v0.8.8：基础依赖初次运行检测一次（结果持久化；后续仅设置页手动重测）
    from backend.infrastructure.deps import refresh_dependencies

    await refresh_dependencies()
    _t2 = time.perf_counter()
    await _heal_legacy_plans()
    await _heal_legacy_crews()
    _t3 = time.perf_counter()
    registry.scheduler.start()
    _t4 = time.perf_counter()
    try:
        resumed = await registry.monoline.reconcile()
        if resumed:
            log_manager.get().info("monoline reconcile parked %d job(s)", len(resumed))
    except Exception:  # noqa: BLE001 — 启动不因融合域愈合失败而中断
        log_manager.get().exception("monoline reconcile failed (best effort)")
    # v0.21：固化包冷启动归因打点（>30s 环节定位用）
    log_manager.get().info(
        "[startup-timing] registry %.2fs / deps %.2fs / heal %.2fs / scheduler %.2fs / total %.2fs",
        _t1 - _t0,
        _t2 - _t1,
        _t3 - _t2,
        _t4 - _t3,
        _t4 - _t0,
    )
    yield
    await registry.shutdown()
    log_manager.get().info("Hertz backend stopped")


app = FastAPI(title="Hertz", version=APP_VERSION, lifespan=lifespan)

register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{settings.frontend_port}"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
