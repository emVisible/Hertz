"""Shared CRUD scaffolding for orchestration entities.

Each entity service follows the same shape: standalone DB sessions via
``session_factory``, async serialization, stable error codes.
v0.8：_serialize 统一为 async（模板方法）——buffs/roles/depths/brief_groups/
templates 全部继承本基类，消灭三套手抄实现。
"""

from uuid import UUID

from sqlalchemy import func, select

from backend.models.base import BaseModel
from backend.models.session import session_factory
from backend.orchestration.errors import NotFoundError


class BaseCrudService:
    model: type[BaseModel]

    async def create(self, **fields) -> dict:
        obj = self.model(**fields)
        async with session_factory() as session:
            session.add(obj)
            await session.commit()
            await session.refresh(obj)
        return await self._serialize(obj)

    async def list(self, limit: int = 100) -> list[dict]:
        order = func.coalesce(self.model.updated_at, self.model.created_at).desc()
        async with session_factory() as session:
            result = await session.execute(
                select(self.model).order_by(order).limit(limit)
            )
            return [await self._serialize(o) for o in result.scalars().all()]

    async def get(self, obj_id: UUID) -> dict:
        obj = await self._load(obj_id)
        if obj is None:
            raise NotFoundError()
        return await self._serialize(obj)

    async def update(self, obj_id: UUID, **fields) -> dict:
        """Apply only the explicitly provided fields.

        Unlike `**fields` filtering on `None`, this keeps the ability to
        clear a column (crew_id=None, description="" etc.) — callers build
        the dict from request body key presence, not truthiness.
        """
        obj = await self._load(obj_id)
        if obj is None:
            raise NotFoundError()
        for key, value in fields.items():
            setattr(obj, key, value)
        async with session_factory() as session:
            await session.merge(obj)
            await session.commit()
        return await self._serialize(obj)

    async def delete(self, obj_id: UUID) -> None:
        # Single session: get + delete on detached instances across sessions
        # is unreliable with asyncpg (instance is unpersisted in the new one).
        async with session_factory() as session:
            obj = await session.get(self.model, obj_id)
            if obj is None:
                raise NotFoundError()
            await session.delete(obj)
            await session.commit()

    async def _load(self, obj_id: UUID):
        async with session_factory() as session:
            return await session.get(self.model, obj_id)

    async def _serialize(self, obj: BaseModel) -> dict:
        raise NotImplementedError
