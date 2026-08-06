"""RoleService — 角色库 CRUD（v4.1 简化）。

角色 = 内容型实体：key/name/role_name + MD description。
执行配置（method/style/model/timeout/retries）归工序库，角色不持有。
"""

import logging
from uuid import UUID

from sqlalchemy import select

from backend.models.role import Role
from backend.models.session import session_factory
from backend.orchestration.phases import DEFAULT_AGENTS

logger = logging.getLogger(__name__)


class RoleService:
    async def _seed(self) -> None:
        """首次访问：种入默认 5 角色（幂等，已存在跳过）。

        默认角色的 MD description 由 DEFAULT_AGENTS 的 method/style 组合生成。
        """
        async with session_factory() as session:
            existing = set((await session.execute(select(Role.key))).scalars().all())
            missing = [a for a in DEFAULT_AGENTS if a["key"] not in existing]
            if not missing:
                return
            for i, agent in enumerate(missing):
                parts = [f"# {agent.get('role', agent['key'])}"]
                if agent.get("method"):
                    parts.append(f"## 方法论\n\n{agent['method']}")
                if agent.get("style"):
                    parts.append(f"## 风格\n\n{', '.join(str(s) for s in agent['style'])}")
                session.add(
                    Role(
                        key=agent["key"],
                        name=agent["key"],
                        role_name=agent.get("role", agent["key"]),
                        description="\n\n".join(parts),
                        sort_order=i,
                    )
                )
            await session.commit()
            logger.info("seeded %d default role(s)", len(missing))

    async def list_roles(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(Role).order_by(Role.sort_order, Role.created_at)
                )).scalars().all()
            )
            return [self._serialize(r) for r in rows]

    async def get(self, role_id: UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            return self._serialize(row)

    async def create(
        self,
        *,
        key: str,
        name: str,
        role_name: str = "",
        description: str = "",
    ) -> dict:
        async with session_factory() as session:
            exists = (await session.execute(
                select(Role).where(Role.key == key)
            )).scalar_one_or_none()
            if exists is not None:
                raise ValueError(f"role key already exists: {key}")
            row = Role(
                key=key,
                name=name.strip(),
                role_name=role_name.strip() or name.strip(),
                description=description,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def update(self, role_id: UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    setattr(row, key, value)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def delete(self, role_id: UUID) -> None:
        async with session_factory() as session:
            row = await session.get(Role, role_id)
            if row is None:
                raise KeyError(f"role not found: {role_id}")
            await session.delete(row)
            await session.commit()

    @staticmethod
    def _serialize(row: Role) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "role_name": row.role_name,
            "description": row.description,
            "enabled": row.enabled,
            "sort_order": row.sort_order,
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
