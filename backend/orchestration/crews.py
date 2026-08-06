"""TeamService（表名 crews，语义=团队 v4.0）— 角色的集合。

团队只存角色 key 的有序列表；角色配置在角色库（roles 表）。
序列化时按 key 展开角色配置，前端直接渲染。
BaseCrudService 的 `_serialize` 是同步契约，这里覆盖各 CRUD 方法改用
异步序列化（需要查角色库）。
"""

import logging
from uuid import UUID

from sqlalchemy import select

from backend.models.crew import Crew
from backend.models.role import Role
from backend.models.session import session_factory
from backend.orchestration.errors import NotFoundError

logger = logging.getLogger(__name__)


class CrewService:
    model = Crew

    # ---------- role resolution ----------

    async def _resolve_roles(self, role_keys: list[str]) -> list[dict]:
        """角色 key → 角色配置（保持团队内的顺序）。"""
        if not role_keys:
            return []
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Role).where(Role.key.in_(role_keys))
                )).scalars().all()
            )
            index = {r.key: r for r in rows}
            return [
                self._serialize_role(index[k])
                for k in role_keys
                if k in index
            ]

    @staticmethod
    def _serialize_role(row: Role) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "role_name": row.role_name,
            "description": row.description,
            "enabled": row.enabled,
        }

    async def _serialize(self, crew: Crew) -> dict:
        keys = [k for k in (crew.agents or []) if isinstance(k, str)]
        roles = await self._resolve_roles(keys)
        return {
            "id": str(crew.id),
            "name": crew.name,
            "description": crew.description,
            "role_keys": keys,
            "roles": roles,
            "created_at": crew.created_at.isoformat() if crew.created_at else None,
            "updated_at": crew.updated_at.isoformat() if crew.updated_at else None,
        }

    # ---------- CRUD（异步序列化版） ----------

    async def create(
        self, name: str, description: str = "", role_keys: list | None = None
    ) -> dict:
        crew = Crew(
            name=name,
            description=description,
            agents=role_keys if role_keys is not None else [],
        )
        async with session_factory() as session:
            session.add(crew)
            await session.commit()
            await session.refresh(crew)
        return await self._serialize(crew)

    async def list(self, limit: int = 100) -> list[dict]:
        async with session_factory() as session:
            result = await session.execute(
                select(Crew).order_by(Crew.updated_at.desc()).limit(limit)
            )
            rows = result.scalars().all()
        return [await self._serialize(r) for r in rows]

    async def get(self, obj_id: UUID) -> dict:
        crew = await self._load(obj_id)
        if crew is None:
            raise NotFoundError()
        return await self._serialize(crew)

    async def update(self, obj_id: UUID, fields: dict) -> dict:
        crew = await self._load(obj_id)
        if crew is None:
            raise NotFoundError()
        for key, value in fields.items():
            setattr(crew, key, value)
        async with session_factory() as session:
            await session.merge(crew)
            await session.commit()
        return await self._serialize(crew)

    async def delete(self, obj_id: UUID) -> None:
        async with session_factory() as session:
            crew = await session.get(Crew, obj_id)
            if crew is None:
                raise NotFoundError()
            await session.delete(crew)
            await session.commit()

    async def _load(self, obj_id: UUID):
        async with session_factory() as session:
            return await session.get(Crew, obj_id)

    # ---------- engine ----------

    async def agents_map(self, crew_id: UUID) -> dict[str, dict]:
        """引擎用：团队 → {角色 key: 扮演名}。

        v4.1：角色只提供 role_name（扮演名）；method/style/model/timeout/retries
        由引擎回退到工序库配置（phase）——执行配置不在角色层。
        """
        crew = await self._load(crew_id)
        if crew is None:
            return {}
        keys = [k for k in (crew.agents or []) if isinstance(k, str)]
        if not keys:
            return {}
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Role).where(Role.key.in_(keys), Role.enabled.is_(True))
                )).scalars().all()
            )
            index = {r.key: r for r in rows}
            return {
                k: {"role": index[k].role_name or index[k].name}
                for k in keys
                if k in index
            }
