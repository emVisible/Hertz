"""StudioService — plan execution entry point.

Owns run lifecycle: single-flight guard, background task management,
cancellation, run history and output file access. The heavy lifting is
delegated to PhaseEngine.
"""

import asyncio
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select

from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore, next_output_slug
from backend.models.brief import Brief
from backend.models.plan import PhaseRun, Plan, WorkflowRun, WorkflowRunStatus
from backend.models.session import session_factory
from backend.orchestration.engine import PhaseEngine
from backend.orchestration.errors import AlreadyRunningError, NotFoundError
from backend.orchestration.plans import PlanService

logger = logging.getLogger(__name__)


def _phase_files(phase_run, run_dir: Path) -> list[str]:
    """阶段产物文件：读取 run 目录真实文件，按阶段归属（同步，调用方 to_thread）。

    规则：
    - `{key}.md` → 该阶段（completed 才列出）
    - output_file 声明（brief.md/final.md/pipeline.md）→ 该阶段
    - `images/*` → visual_director
    - package 阶段额外列出 final.md（打包交付总成）
    - user-input.md 是输入不是产物，不归属任何阶段
    """
    key = phase_run.phase_key
    names: list[str] = []
    out = phase_run.output_json or {}
    declared = str(out.get("output_file") or out.get("file") or "")
    if declared and declared not in ("images/",):
        names.append(declared)

    # 从 run 目录读取真实存在的文件，匹配该阶段产物
    if run_dir.is_dir():
        try:
            for f in run_dir.iterdir():
                if not f.is_file():
                    continue
                fname = f.name
                if fname == f"{key}.md" or fname == declared:
                    names.append(fname)
            images = run_dir / "images"
            if key == "visual_director" and images.is_dir():
                imgs = sorted(p.name for p in images.iterdir() if p.is_file())
                if imgs:
                    names.append("images/")
        except OSError:
            pass

    # package 汇总 final.md
    if key == "package" and phase_run.status == "completed":
        if (run_dir / "final.md").is_file():
            names.append("final.md")

    # 去重保序
    seen: set[str] = set()
    return [n for n in names if not (n in seen or seen.add(n))]


class StudioService:
    def __init__(self, files: FileStore, hub: EventHub) -> None:
        self.files = files
        self.hub = hub
        self._task: asyncio.Task | None = None
        self._current_run_id: uuid.UUID | None = None

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def current_run_id(self) -> str | None:
        return str(self._current_run_id) if self._current_run_id else None

    # ---------- run lifecycle ----------

    async def start(
        self, plan_id: uuid.UUID, topic: str, buff_keys: list[str] | None = None,
        depth: str = "normal",
    ) -> dict:
        if self.running:
            raise AlreadyRunningError()
        async with session_factory() as session:
            plan = await session.get(Plan, plan_id)
            if plan is None:
                raise NotFoundError("plan not found")
            # 运行时归一化并存回：旧计划里已移除的工序（preflight/scout/image_gen…）
            # 折叠到现行工序（preflight→build_brief 等）或剔除，别名目标（如
            # growth_director→distribution）才会真正执行，而不是被跳过。
            cleaned = PlanService.validate_phase_order(plan.phase_order)
            if cleaned is not None and cleaned != plan.phase_order:
                plan.phase_order = cleaned
                await session.commit()
            brief = None
            # v0.7 策略组：组优先于单个 brief——挂了组则忽略 brief_id
            if plan.brief_group_id is not None:
                from backend.orchestration.brief_groups import BriefGroupService

                group_content = await BriefGroupService().resolve_content(
                    plan.brief_group_id
                )
                if group_content:
                    brief = Brief(
                        name="策略组",
                        content=group_content,
                    )
            if brief is None and plan.brief_id is not None:
                brief = await session.get(Brief, plan.brief_id)
            run = WorkflowRun(
                status=WorkflowRunStatus.RUNNING,
                plan_id=plan_id,
                context_json={"topic": topic, "plan": plan.name},
            )
            # 产物目录结构化命名：studio/2026-08-04-01（日期 + 当日第几次）
            slug = next_output_slug(self.files.output_root() / "studio")
            run.output_dir = f"studio/{slug}"
            session.add(run)
            await session.commit()
            await session.refresh(run)
            run_id = run.id

        agents = await self._agents_for_plan(plan_id)
        # 运行时 buff 覆盖：显式传入则用运行时值；否则用计划持久配置（v5.0）
        effective_buffs = (
            buff_keys if buff_keys is not None else list(plan.buff_keys or [])
        )
        self._current_run_id = run_id
        self._task = asyncio.create_task(
            self._execute(
                run_id, plan, brief, topic, agents,
                buff_keys=effective_buffs, depth=depth or "normal",
            ),
            name=f"studio-run-{run_id}",
        )
        return {"id": str(run_id), "status": WorkflowRunStatus.RUNNING}

    async def _agents_for_plan(self, plan_id: uuid.UUID) -> dict[str, dict]:
        async with session_factory() as session:
            plan = await session.get(Plan, plan_id)
            if plan is None or plan.crew_id is None:
                return {}
        from backend.factory.registry import ServiceRegistry  # deferred: registry imports studio

        return await ServiceRegistry.get().crews.agents_map(plan.crew_id)

    async def _execute(
        self, run_id: uuid.UUID, plan, brief, topic: str, agents: dict,
        buff_keys: list[str] | None = None,
        depth: str = "normal",
    ) -> None:
        from backend.factory.registry import ServiceRegistry  # deferred: registry imports studio

        engine = PhaseEngine(self.files, self.hub, ai=ServiceRegistry.get().ai)
        engine.phases = ServiceRegistry.get().phases
        engine.buff_keys = buff_keys or []
        engine.depth = depth or "normal"
        try:
            result = await engine.run(
                run=await self._reload(run_id), plan=plan, topic=topic, brief=brief, agents=agents
            )
        except asyncio.CancelledError:
            status = WorkflowRunStatus.CANCELLED
            error = "cancelled by user"
            self._emit_done(run_id, "cancelled", error)
        except Exception as exc:  # noqa: BLE001 — persist any run crash
            logger.exception("studio run %s crashed", run_id)
            status = WorkflowRunStatus.FAILED
            error = str(exc)[:500]
            self._emit_done(run_id, "failed", error)
        else:
            status = result.status
            error = result.error
        finally:
            self._current_run_id = None
            self._task = None

        await self._finish_run(run_id, status, error)

    async def cancel(self) -> dict:
        if self._task is None or self._task.done():
            raise NotFoundError("no run in progress")
        self._task.cancel()
        # Finalize immediately and idempotently. The run task may have been
        # cancelled before it ever ran (never scheduled), in which case its
        # own cleanup never executes; a later duplicate write is harmless.
        run_id = self._current_run_id
        if run_id is not None:
            await self._finish_run(run_id, WorkflowRunStatus.CANCELLED, "cancelled by user")
        return {"ok": True, "cancelling": True}

    # ---------- history & outputs ----------

    async def list_runs(self, limit: int = 20) -> list[dict]:
        async with session_factory() as session:
            result = await session.execute(
                select(WorkflowRun).order_by(WorkflowRun.started_at.desc()).limit(limit)
            )
            return [self._serialize_run(r) for r in result.scalars().all()]

    async def get_run(self, run_id: uuid.UUID) -> dict:
        async with session_factory() as session:
            run = await session.get(WorkflowRun, run_id)
            if run is None:
                raise NotFoundError("run not found")
            phases = await session.execute(
                select(PhaseRun).where(PhaseRun.run_id == run_id).order_by(PhaseRun.created_at)
            )
            data = self._serialize_run(run)
            run_dir = self.files.run_dir(run)
            data["phases"] = [
                {
                    "key": p.phase_key,
                    "status": p.status,
                    "duration_ms": p.duration_ms,
                    "error": p.error,
                    "output": p.output_json or {},
                    # 该阶段真实产物文件（读 run 目录归属；文件 IO 走线程池）
                    "files": await asyncio.to_thread(_phase_files, p, run_dir),
                }
                for p in phases.scalars().all()
            ]
            return data

    async def run_dir(self, run_id: uuid.UUID) -> Path:
        async with session_factory() as session:
            run = await session.get(WorkflowRun, run_id)
        return self.files.run_dir(run)

    async def list_files(self, run_id: uuid.UUID) -> list[str]:
        directory = await self.run_dir(run_id)
        if not directory.exists():
            # 历史 run 的输出可能被移动/清理/路径变更：降级为空而非报错刷屏
            return []
        files = await asyncio.to_thread(list, directory.iterdir())
        names = sorted(p.name for p in files if p.is_file())
        images = directory / "images"
        if images.is_dir():
            imgs = await asyncio.to_thread(list, images.iterdir())
            names += [f"images/{p.name}" for p in imgs if p.is_file()]
        return names

    async def read_file(self, run_id: uuid.UUID, name: str) -> tuple[bytes | None, str]:
        directory = await self.run_dir(run_id)
        target = (directory / name).resolve()
        # Path traversal guard (AXIOM §8.1): stay inside the run output dir.
        try:
            target.relative_to(directory.resolve())
        except ValueError as exc:
            raise NotFoundError(f"file not found: {name}") from exc
        try:
            return await asyncio.to_thread(target.read_bytes), name
        except OSError as exc:
            raise NotFoundError(f"file not found: {name}") from exc

    # ---------- internals ----------

    async def _reload(self, run_id: uuid.UUID) -> WorkflowRun:
        async with session_factory() as session:
            run = await session.get(WorkflowRun, run_id)
            if run is None:  # pragma: no cover — run was deleted mid-flight
                raise NotFoundError("run not found")
            return run

    async def _finish_run(self, run_id: uuid.UUID, status: str, error: str = "") -> None:
        try:
            async with session_factory() as session:
                run = await session.get(WorkflowRun, run_id)
                if run is None:
                    return
                run.status = status
                run.error = error or None
                run.finished_at = datetime.now(UTC)
                await session.merge(run)
                await session.commit()
        except Exception:  # noqa: BLE001 — finishing is best-effort
            logger.exception("failed to finalize run %s", run_id)

    def _emit_done(self, run_id: uuid.UUID, status: str, error: str) -> None:
        data = {"type": "run_done", "run_id": str(run_id), "status": status, "error": error or None}
        self.hub.publish(f"studio:{run_id}", data)
        self.hub.publish("studio", data)

    def _serialize_run(self, run: WorkflowRun) -> dict:
        rel = run.output_dir or f"studio/{run.id.hex}"
        return {
            "id": str(run.id),
            "plan_id": str(run.plan_id) if run.plan_id else None,
            "status": run.status,
            "error": run.error,
            "context": run.context_json or {},
            "started_at": run.started_at.isoformat() if run.started_at else None,
            "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            "output_dir": rel,
            # 绝对路径，供资源页深链（/assets?path=...）直接定位到该次运行产物目录
            "output_path": str(self.files.run_dir(run).resolve()),
        }
