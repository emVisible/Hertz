"""生产方式预设模板服务（v0.4 B3）：命名组合一键套用批量生产方式。

内置四模板以代码为准（_seed 同步）：直发 / 配音+字幕 / 翻译+字幕 / 静音。
options_json 存生产方式模块组合（passthrough/voice/subtitle/translate/mute）。
"""

import json
import logging
import uuid

from sqlalchemy import select

from backend.models.pipeline import ProduceTemplate
from backend.models.session import session_factory

logger = logging.getLogger(__name__)

# 内置模板单一真相源（与前端 ProduceOptionsPicker 模块语义一致）
BUILTIN_TEMPLATES: list[dict] = [
    {"name": "直发", "options": {"passthrough": True}},
    {"name": "配音+字幕", "options": {"voice": True, "subtitle": True}},
    {"name": "翻译+字幕", "options": {"translate": True, "subtitle": True}},
    {"name": "静音直发", "options": {"mute": True}},
]


class ProduceTemplateService:
    async def _seed(self) -> None:
        async with session_factory() as session:
            rows = (await session.execute(select(ProduceTemplate))).scalars().all()
            by_name = {r.name: r for r in rows if r.builtin}
            changed = 0
            for i, tpl in enumerate(BUILTIN_TEMPLATES):
                row = by_name.get(tpl["name"])
                raw = json.dumps(tpl["options"], ensure_ascii=False)
                if row is None:
                    session.add(
                        ProduceTemplate(
                            name=tpl["name"],
                            options_json=raw,
                            builtin=True,
                            sort_order=i,
                        )
                    )
                    changed += 1
                elif row.options_json != raw or row.sort_order != i:
                    row.options_json = raw
                    row.sort_order = i
                    changed += 1
            if changed:
                await session.commit()
                logger.info("synced %d builtin produce template(s)", changed)

    async def list_templates(self) -> list[dict]:
        await self._seed()
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(ProduceTemplate).order_by(
                        ProduceTemplate.sort_order.asc(), ProduceTemplate.created_at.asc()
                    )
                )
            ).scalars().all()
            return [self._serialize(r) for r in rows]

    async def create(self, *, name: str, options: dict) -> dict:
        async with session_factory() as session:
            row = ProduceTemplate(
                name=name,
                options_json=json.dumps(options, ensure_ascii=False),
                builtin=False,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def update(self, template_id: uuid.UUID, **fields) -> dict:
        async with session_factory() as session:
            row = await session.get(ProduceTemplate, template_id)
            if row is None:
                raise KeyError("produce template not found")
            for k, v in fields.items():
                if v is not None:
                    if k == "options":
                        row.options_json = json.dumps(v, ensure_ascii=False)
                    else:
                        setattr(row, k, v)
            await session.merge(row)
            await session.commit()
            await session.refresh(row)
            return self._serialize(row)

    async def delete(self, template_id: uuid.UUID) -> None:
        async with session_factory() as session:
            row = await session.get(ProduceTemplate, template_id)
            if row is None:
                raise KeyError("produce template not found")
            await session.delete(row)
            await session.commit()

    @staticmethod
    def _serialize(row: ProduceTemplate) -> dict:
        try:
            options = json.loads(row.options_json or "{}")
        except (ValueError, TypeError):
            options = {}
        return {
            "id": str(row.id),
            "name": row.name,
            "options": options if isinstance(options, dict) else {},
            "builtin": row.builtin,
            "sort_order": row.sort_order,
        }
