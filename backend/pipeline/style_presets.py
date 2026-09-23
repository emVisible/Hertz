"""风格预设服务（v0.26 创作资产）：命名栏目创意包的 CRUD + 套用到栏目。

复用 ProduceTemplate 模式（BaseCrudService + JSON 序列化）；
apply 仅写创意子集，归属类字段（name/source_pool/enabled）不动。
"""

import json
import logging
from uuid import UUID

from sqlalchemy import select

from backend.models.channel import Channel
from backend.models.pipeline import StylePreset
from backend.models.session import session_factory
from backend.orchestration.crud import BaseCrudService
from backend.orchestration.errors import NotFoundError

logger = logging.getLogger(__name__)

# 预设可携带的创意键（Channel 创意子集——归属类字段排除）
PRESET_KEYS = (
    "voice",
    "bili_tid",
    "desc_template",
    "tags",
    "title_style_prompt",
    "persona_prompt",
    "intro_config",
)


class StylePresetService(BaseCrudService):
    model = StylePreset

    async def list_presets(self) -> list[dict]:
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(StylePreset).order_by(
                        StylePreset.sort_order.asc(), StylePreset.created_at.asc()
                    )
                )
            ).scalars().all()
            return [await self._serialize(r) for r in rows]

    async def create(self, *, name: str, config: dict) -> dict:
        cleaned = {k: config.get(k) for k in PRESET_KEYS if k in config}
        async with session_factory() as session:
            row = StylePreset(
                name=name.strip()[:120],
                config_json=json.dumps(cleaned, ensure_ascii=False),
                builtin=False,
            )
            session.add(row)
            await session.commit()
            await session.refresh(row)
            return await self._serialize(row)

    async def apply_to_channel(self, preset_id: UUID, channel_key: str) -> dict:
        """预设创意子集覆盖到栏目（归属字段不动），返回更新后栏目的创意字段。"""
        async with session_factory() as session:
            preset = await session.get(StylePreset, preset_id)
            if preset is None:
                raise NotFoundError(f"style preset {preset_id} not found")
            try:
                config = json.loads(preset.config_json or "{}")
            except (ValueError, TypeError):
                config = {}
            channel = (
                await session.execute(
                    select(Channel).where(Channel.public_id == channel_key)
                )
            ).scalar_one_or_none()
            if channel is None:
                raise NotFoundError(f"channel '{channel_key}' not found")
            for key in PRESET_KEYS:
                if key in config:
                    setattr(channel, key, config[key])
            await session.commit()
            await session.refresh(channel)
            from backend.routers.channels import _channel_dict

            return _channel_dict(channel)

    @staticmethod
    async def _serialize(row: StylePreset) -> dict:
        try:
            config = json.loads(row.config_json or "{}")
        except (ValueError, TypeError):
            config = {}
        return {
            "id": str(row.id),
            "name": row.name,
            "config": config if isinstance(config, dict) else {},
            "builtin": row.builtin,
            "sort_order": row.sort_order,
        }
