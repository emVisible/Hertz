"""PromptTemplateService — 提示词模板库（v2.4）。

出厂默认模板定义在 backend/ai/prompts/templates.py（单一真相源）；
首次访问种入 DB，用户在界面编辑后以 DB 为准（customized=True 时
升级不覆盖）。调用方通过 get(key) 拿最终内容。

与现有硬编码提示词的关系：prompts/agent.py 等保留构建函数，
但 SYSTEM 常量改为从这里取（DB 覆盖 → 出厂默认兜底）。
"""

import logging
from dataclasses import dataclass

from sqlalchemy import select

from backend.ai.prompts import templates as factory
from backend.models.ai_registry import AIPromptTemplate
from backend.models.session import session_factory

logger = logging.getLogger(__name__)


@dataclass
class PromptEntry:
    key: str
    name: str
    category: str
    content: str
    version: int
    customized: bool


class PromptTemplateService:
    async def _seed(self) -> None:
        """首次访问：把出厂默认种入 DB（已存在的跳过）。"""
        async with session_factory() as session:
            existing = set(
                (await session.execute(select(AIPromptTemplate.key))).scalars().all()
            )
            missing = [e for e in factory.FACTORY_TEMPLATES if e.key not in existing]
            if not missing:
                return
            session.add_all(
                [
                    AIPromptTemplate(
                        key=e.key,
                        name=e.name,
                        category=e.category,
                        content=e.content,
                    )
                    for e in missing
                ]
            )
            await session.commit()

    async def list(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                (await session.execute(
                    select(AIPromptTemplate)
                    .order_by(AIPromptTemplate.category, AIPromptTemplate.key)
                )).scalars().all()
            )
            return [self._serialize(r) for r in rows]

    async def get(self, key: str) -> str:
        """取模板内容：DB 优先，出厂默认兜底（不种库，读取快路径）。"""
        try:
            async with session_factory() as session:
                row = (await session.execute(
                    select(AIPromptTemplate).where(AIPromptTemplate.key == key)
                )).scalar_one_or_none()
                if row is not None and row.content:
                    return row.content
        except Exception:  # noqa: BLE001 — DB 不可用时用出厂默认
            logger.debug("prompt template DB read failed, using factory default: %s", key)
        return factory.get_default(key)

    async def update(self, key: str, content: str) -> dict:
        """保存模板（标记 customized，升级不覆盖）。"""
        await self._seed()
        async with session_factory() as session:
            row = (await session.execute(
                select(AIPromptTemplate).where(AIPromptTemplate.key == key)
            )).scalar_one_or_none()
            if row is None:
                raise KeyError(f"prompt template not found: {key}")
            row.content = content
            row.customized = True
            row.version += 1
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def reset(self, key: str) -> dict:
        """恢复出厂默认（去掉 customized 标记）。"""
        await self._seed()
        default = factory.get_default(key)
        async with session_factory() as session:
            row = (await session.execute(
                select(AIPromptTemplate).where(AIPromptTemplate.key == key)
            )).scalar_one_or_none()
            if row is None:
                raise KeyError(f"prompt template not found: {key}")
            row.content = default
            row.customized = False
            row.version += 1
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    @staticmethod
    def _serialize(row: AIPromptTemplate) -> dict:
        return {
            "id": str(row.id),
            "key": row.key,
            "name": row.name,
            "category": row.category,
            "content": row.content,
            "version": row.version,
            "customized": row.customized,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }


prompt_templates = PromptTemplateService()
