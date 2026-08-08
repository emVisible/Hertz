"""PhasesService — user-maintainable phase catalog.

内置工序（代码常量）懒种子进 DB（builtin=True，只读保护）；
自定义工序（agent 类型，LLM 驱动）支持增删改。engine 通过
`index()` 获取合并后的 PhaseDef 索引（内存缓存 + DB 同步）。
"""

from __future__ import annotations

import logging

from sqlalchemy import select

from backend.models.phase import PhaseStore, new_phase_key
from backend.models.session import session_factory
from backend.orchestration.phases import PHASES, PhaseDef, phase_agent_config

logger = logging.getLogger(__name__)

# 旧版内置 role 是英文（Creative Director 等），统一为中文；存量行按此迁移
_LEGACY_EN_ROLES = {
    "Creative Director": "创意总监",
    "Content Writer": "内容作家",
    "Visual Director": "视觉导演",
    "Content Editor": "内容编辑",
    "Distribution Strategist": "分发策略师",
}


class PhasesService:
    def __init__(self) -> None:
        self._index: dict[str, PhaseDef] | None = None

    # ---------- seeding ----------

    async def _seed_builtins(self) -> None:
        async with session_factory() as session:
            existing = set(
                (await session.execute(select(PhaseStore.key))).scalars().all()
            )
            # 已从 PHASES 移除的内置工序（preflight/image_gen/quality_gate 等）
            # 软归档，不复活；用户自定义工序不受影响
            builtin_keys = {p.key for p in PHASES}
            for key in existing:
                if key in builtin_keys:
                    continue
                row = (await session.execute(
                    select(PhaseStore).where(PhaseStore.key == key)
                )).scalar_one_or_none()
                if row is not None and row.builtin and not row.archived:
                    row.archived = True
            for order, p in enumerate(PHASES):
                if p.key in existing:
                    continue
                conf = phase_agent_config(p)
                session.add(
                    PhaseStore(
                        key=p.key,
                        name=p.name,
                        phase_type=p.phase_type,
                        agent_key=p.agent_key or p.key,
                        description=getattr(p, "description", ""),
                        output_file=getattr(p, "output_file", ""),
                        phase_group=getattr(p, "phase_group", "infrastructure"),
                        timeout=getattr(p, "timeout", 300),
                        builtin=True,
                        sort_order=order,
                        role=conf["role"],
                        method=conf["method"],
                        style=conf["style"],
                        model=conf["model"],
                        retries=conf["retries"],
                    )
                )
            # 存量内置工序补齐 role/method/style（升级时 seed 已存在行；归档的不复活）
            for key in existing:
                phase = next((x for x in PHASES if x.key == key), None)
                if phase is None:
                    continue
                conf = phase_agent_config(phase)
                row = (await session.execute(
                    select(PhaseStore).where(PhaseStore.key == key)
                )).scalar_one_or_none()
                if row is None or row.archived:
                    continue
                if not row.method:
                    row.role = conf["role"]
                    row.method = conf["method"]
                    row.style = conf["style"]
                    row.model = conf["model"]
                    row.retries = conf["retries"]
                elif row.role in _LEGACY_EN_ROLES:
                    # 语言统一：旧英文 role 迁移为中文（用户已自定义的跳过）
                    row.role = _LEGACY_EN_ROLES[row.role]
            await session.commit()

    # ---------- queries ----------

    async def list(self) -> list[dict]:
        await self._seed_builtins()
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(PhaseStore)
                    .where(PhaseStore.archived.is_(False))
                    .order_by(PhaseStore.sort_order, PhaseStore.name)
                )
            ).scalars().all()
        self._index = None  # 失效缓存
        return [
            {
                "key": r.key,
                "name": r.name,
                "phase_type": r.phase_type,
                "description": r.description,
                "output_file": r.output_file,
                "phase_group": r.phase_group,
                "timeout": r.timeout,
                "builtin": r.builtin,
                "role": r.role,
                "method": r.method,
                "style": r.style,
                "model": r.model,
                "retries": r.retries,
            }
            for r in rows
        ]

    async def index(self) -> dict[str, PhaseDef]:
        """合并后的 PhaseDef 索引（内置 + 自定义），engine 运行时使用。"""
        if self._index is not None:
            return self._index
        await self._seed_builtins()
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(PhaseStore)
                    .where(PhaseStore.archived.is_(False))
                    .order_by(PhaseStore.sort_order, PhaseStore.name)
                )
            ).scalars().all()
        index: dict[str, PhaseDef] = {}
        for r in rows:
            index[r.key] = PhaseDef(
                key=r.key,
                name=r.name,
                phase_type=r.phase_type,
                agent_key=r.agent_key or r.key,
                description=r.description,
                output_file=r.output_file,
                timeout=r.timeout,
                role=r.role,
                method=r.method,
                style=r.style or [],
                model=r.model,
                retries=r.retries,
            )
        self._index = index
        return index

    # ---------- CRUD ----------

    async def create(
        self, name: str, description: str = "", *, method: str = "", style: list | None = None
    ) -> dict:
        await self._seed_builtins()
        key = new_phase_key(name)
        async with session_factory() as session:
            session.add(
                PhaseStore(
                    key=key,
                    name=name.strip()[:120] or "自定义工序",
                    phase_type="agent",
                    agent_key=key,
                    description=description.strip(),
                    output_file=f"{key}.md",
                    phase_group="custom",
                    timeout=300,
                    builtin=False,
                    sort_order=1000,
                    role=name.strip()[:60],
                    method=method.strip(),
                    style=style or [],
                )
            )
            await session.commit()
        self._index = None
        return {
            "key": key,
            "name": name.strip()[:120],
            "phase_type": "agent",
            "description": description.strip(),
            "builtin": False,
            "role": name.strip()[:60],
            "method": method.strip(),
            "style": style or [],
        }

    async def update(
        self,
        key: str,
        *,
        name: str | None = None,
        description: str | None = None,
        role: str | None = None,
        method: str | None = None,
        style: list | None = None,
        model: str | None = None,
        retries: int | None = None,
        timeout_s: int | None = None,
    ) -> dict:
        async with session_factory() as session:
            row = (await session.execute(
                select(PhaseStore).where(PhaseStore.key == key)
            )).scalar_one_or_none()
            if row is None:
                raise KeyError(f"phase not found: {key}")
            if name is not None:
                row.name = name.strip()[:120]
            if description is not None:
                row.description = description.strip()
            if role is not None:
                row.role = role.strip()[:120]
            if method is not None:
                row.method = method.strip()
            if style is not None:
                row.style = style
            if model is not None:
                row.model = model.strip()
            if retries is not None:
                row.retries = int(retries)
            if timeout_s is not None:
                row.timeout = int(timeout_s)
            await session.commit()
        self._index = None
        return {
            "key": key,
            "name": row.name,
            "description": row.description,
            "role": row.role,
            "method": row.method,
            "style": row.style,
            "model": row.model,
            "retries": row.retries,
            "timeout": row.timeout,
        }

    async def delete(self, key: str) -> None:
        async with session_factory() as session:
            row = (await session.execute(
                select(PhaseStore).where(PhaseStore.key == key)
            )).scalar_one_or_none()
            if row is None:
                raise KeyError(f"phase not found: {key}")
            if row.builtin:
                # 内置工序软删除（归档）；可在“恢复默认工序库”中复原
                row.archived = True
            else:
                await session.delete(row)
            await session.commit()
        self._index = None

    async def restore_defaults(self) -> int:
        """一键恢复默认工序库：内置工序全部取消归档并重置为出厂字段，
        自定义工序全部删除。返回恢复/删除的工序数。"""
        await self._seed_builtins()
        async with session_factory() as session:
            rows = (await session.execute(select(PhaseStore))).scalars().all()
            restored = 0
            for r in rows:
                p = next((x for x in PHASES if x.key == r.key), None)
                if r.builtin:
                    if p is None:
                        # 已从出厂清单移除的内置工序（preflight/image_gen/quality_gate）
                        # 保持归档，恢复默认不复活
                        continue
                    conf = phase_agent_config(p)
                    r.archived = False
                    r.name = p.name
                    r.description = getattr(p, "description", "")
                    r.phase_type = p.phase_type
                    r.agent_key = p.agent_key or p.key
                    r.output_file = getattr(p, "output_file", "")
                    r.phase_group = getattr(p, "phase_group", "infrastructure")
                    r.timeout = getattr(p, "timeout", 300)
                    r.role = conf["role"]
                    r.method = conf["method"]
                    r.style = conf["style"]
                    r.model = conf["model"]
                    r.retries = conf["retries"]
                    r.sort_order = 0
                    restored += 1
                else:
                    await session.delete(r)
            await session.commit()
        self._index = None
        return restored
