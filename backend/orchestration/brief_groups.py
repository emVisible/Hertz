"""BriefGroupService — 策略组 CRUD（v0.7）。

策略组 = 策略的集合（brief_ids 引用列表），类比「团队 = 角色的集合」。
计划挂策略组时，组内策略按序拼接注入（组优先于单个 brief）。
"""

import uuid

from sqlalchemy import select

from backend.models.brief import Brief, BriefGroup
from backend.models.session import session_factory


class BriefGroupService:
    async def list_groups(self) -> list[dict]:
        from backend.orchestration.briefs import seed_brief_group

        await seed_brief_group()  # v0.7：内置策略组 seed（幂等）
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(BriefGroup).order_by(BriefGroup.created_at.asc())
                )).scalars().all()
            )
            return [await self._serialize(r) for r in rows]

    async def get(self, group_id: uuid.UUID) -> dict:
        async with session_factory() as session:
            row = await session.get(BriefGroup, group_id)
            if row is None:
                raise KeyError("brief group not found")
            return await self._serialize(row)

    async def create(
        self, *, name: str, description: str = "", brief_ids: list | None = None
    ) -> dict:
        async with session_factory() as session:
            row = BriefGroup(
                name=name,
                description=description,
                brief_ids=[str(i) for i in (brief_ids or [])],
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return await self._serialize(row)

    async def update(self, group_id: uuid.UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(BriefGroup, group_id)
            if row is None:
                raise KeyError("brief group not found")
            for key, value in fields.items():
                if value is not None and hasattr(row, key):
                    if key == "brief_ids":
                        value = [str(i) for i in value]
                    setattr(row, key, value)
            await session.commit()
            await session.refresh(row)
            return await self._serialize(row)

    async def delete(self, group_id: uuid.UUID) -> None:
        async with session_factory() as session:
            row = await session.get(BriefGroup, group_id)
            if row is None:
                raise KeyError("brief group not found")
            # 计划若引用该组 → 解除引用
            from backend.models.plan import Plan

            plans = (
                await session.execute(
                    select(Plan).where(Plan.brief_group_id == group_id)
                )
            ).scalars().all()
            for plan in plans:
                plan.brief_group_id = None
            await session.delete(row)
            await session.commit()

    async def resolve_content(self, group_id: uuid.UUID) -> str:
        """引擎用：组内策略按序拼接（每份标注名称段）。"""
        async with session_factory() as session:
            row = await session.get(BriefGroup, group_id)
            if row is None:
                return ""
            raw_ids = list(row.brief_ids or [])
            if not raw_ids:
                return ""
            ids = [uuid.UUID(str(i)) for i in raw_ids]
            briefs = (
                (await session.execute(
                    select(Brief).where(Brief.id.in_(ids))
                )).scalars().all()
            )
            index = {str(b.id): b for b in briefs}
            parts = []
            for raw_id in ids:
                brief = index.get(str(raw_id))
                if brief is None or not (brief.content or "").strip():
                    continue
                parts.append(
                    f"## 策略：{brief.name}\n\n{brief.content.strip()}"
                )
            return "\n\n".join(parts)

    async def _serialize(self, row: BriefGroup) -> dict:
        brief_ids = [str(i) for i in (row.brief_ids or [])]
        # 附带组内策略名（前端展示）
        async with session_factory() as session:
            names: dict[str, str] = {}
            if brief_ids:
                rows = (
                    await session.execute(
                        select(Brief.id, Brief.name).where(Brief.id.in_(brief_ids))
                    )
                ).all()
                names = {str(bid): bname for bid, bname in rows}
        return {
            "id": str(row.id),
            "name": row.name,
            "description": row.description,
            "brief_ids": brief_ids,
            "brief_names": [names.get(i, "?") for i in brief_ids],
            "created_at": row.created_at.isoformat() if row.created_at else None,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }
