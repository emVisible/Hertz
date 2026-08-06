"""BriefService — creative brief CRUD."""

from backend.models.brief import Brief
from backend.orchestration.crud import BaseCrudService
from backend.orchestration.phases import DEFAULT_BRIEF_CONTENT


class BriefService(BaseCrudService):
    model = Brief

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
        return await super().update(brief_id, fields)

    @staticmethod
    def _serialize(brief: Brief) -> dict:
        return {
            "id": str(brief.id),
            "name": brief.name,
            "content": brief.content,
            "platform_id": brief.platform_id,
            "config": brief.config_json or {},
            "created_at": brief.created_at.isoformat() if brief.created_at else None,
            "updated_at": brief.updated_at.isoformat() if brief.updated_at else None,
        }
