"""BriefService — creative brief CRUD（v0.7：内置策略 seed）。"""

import logging

from sqlalchemy import select

from backend.models.brief import Brief
from backend.models.session import session_factory
from backend.orchestration.anti_ai_assets import BUILTIN_BRIEFS
from backend.orchestration.crud import BaseCrudService
from backend.orchestration.phases import DEFAULT_BRIEF_CONTENT

logger = logging.getLogger(__name__)


class BriefService(BaseCrudService):
    model = Brief

    async def _seed(self) -> None:
        """内置策略 seed（v0.7）：以 name 为锚（幂等，已有同名跳过/同步内容）。

        内置以代码为准：同名内置策略内容随代码升级同步（扩写立即生效）；
        用户改过的同名内置策略会被覆盖——自定义请改名。
        """
        async with session_factory() as session:
            rows = (await session.execute(select(Brief))).scalars().all()
            by_name = {r.name: r for r in rows}
            changed = 0
            for brief in BUILTIN_BRIEFS:
                row = by_name.get(brief["name"])
                if row is None:
                    session.add(
                        Brief(
                            name=brief["name"],
                            content=brief["content"],
                            platform_id=brief.get("platform_id", ""),
                        )
                    )
                    changed += 1
                elif row.content != brief["content"]:
                    row.content = brief["content"]
                    changed += 1
            if changed:
                await session.commit()
                logger.info("synced %d builtin brief(s)", changed)

    async def list(self, limit: int = 100) -> list[dict]:
        await self._seed()
        return await super().list(limit)

    async def create(
        self,
        name: str,
        content: str = "",
        platform_id: str = "",
        config_json: dict | None = None,
    ) -> dict:
        return await super().create(
            name=name,
            content=content or DEFAULT_BRIEF_CONTENT,
            platform_id=platform_id,
            config_json=config_json,
        )

    async def update(self, brief_id, **fields) -> dict:
        return await super().update(brief_id, **fields)

    @staticmethod
    async def _serialize(brief: Brief) -> dict:
        return {
            "id": str(brief.id),
            "name": brief.name,
            "content": brief.content,
            "platform_id": brief.platform_id,
            "config": brief.config_json or {},
            "created_at": brief.created_at.isoformat() if brief.created_at else None,
            "updated_at": brief.updated_at.isoformat() if brief.updated_at else None,
        }


async def seed_brief_group() -> None:
    """内置策略组 seed（v0.7）：「反 AI 策略组」引用内置策略（幂等）。"""
    from backend.models.brief import BriefGroup
    from backend.orchestration.anti_ai_assets import BUILTIN_BRIEF_GROUPS

    async with session_factory() as session:
        briefs = (await session.execute(select(Brief))).scalars().all()
        brief_by_key = {b.name: b for b in briefs}
        for group in BUILTIN_BRIEF_GROUPS:
            exists = (
                await session.execute(
                    select(BriefGroup).where(BriefGroup.name == group["name"])
                )
            ).scalar_one_or_none()
            ids = []
            for key in group["brief_keys"]:
                brief = brief_by_key.get(key)
                if brief is not None:
                    ids.append(brief.id)
            str_ids = [str(i) for i in ids]
            if exists is None:
                session.add(
                    BriefGroup(
                        name=group["name"],
                        description=group["description"],
                        brief_ids=str_ids,
                    )
                )
            else:
                exists.brief_ids = str_ids
        await session.commit()
