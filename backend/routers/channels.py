"""栏目 REST endpoints（v0.22 栏目化内容工厂）。

GET    /channels            列表（created_at 升序）
POST   /channels            新建
PUT    /channels/{key}      更新
DELETE /channels/{key}      删除
GET    /channels/voices     edge-tts 音色目录（UI 下拉用）

非破坏性：栏目删除不影响已入库条目（channel_key 仅作运行期配置引用）。
"""

import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.models.channel import Channel
from backend.models.session import session_factory
from backend.pipeline.producers.tts_voice import list_voices

router = APIRouter(prefix="/channels", tags=["channels"])

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


class ChannelBody(BaseModel):
    public_id: str | None = Field(
        default=None, description="稳定 key（slug）；缺省服务端生成"
    )
    name: str = Field(min_length=1, max_length=64)
    enabled: bool = True
    source_pool: list[str] = Field(default_factory=list, max_length=32)
    voice: str | None = Field(default=None, max_length=64)
    bili_tid: int | None = Field(default=None, ge=0, le=1000)
    desc_template: str | None = Field(default=None, max_length=2000)
    tags: list[str] = Field(default_factory=list, max_length=20)
    title_style_prompt: str | None = Field(default=None, max_length=2000)
    persona_prompt: str | None = Field(default=None, max_length=4000)
    intro_config: dict | None = Field(default=None)


def _apply(channel: Channel, body: ChannelBody) -> None:
    channel.name = body.name.strip()
    channel.enabled = body.enabled
    channel.source_pool = [s.strip() for s in body.source_pool if s.strip()]
    channel.voice = (body.voice or "").strip() or None
    channel.bili_tid = body.bili_tid if body.bili_tid else None
    channel.desc_template = (body.desc_template or "").strip() or None
    channel.tags = [t.strip() for t in body.tags if t.strip()]
    channel.title_style_prompt = (body.title_style_prompt or "").strip() or None
    channel.persona_prompt = (body.persona_prompt or "").strip() or None
    intro = body.intro_config or {}
    channel.intro_config = {
        "enabled": bool(intro.get("enabled")),
        "duration_s": max(1.0, min(float(intro.get("duration_s") or 3), 10.0)),
        "subtitle": str(intro.get("subtitle") or "").strip()[:60],
    }


@router.get("")
async def list_channels() -> list[dict]:
    async with session_factory() as session:
        channels = (
            (
                await session.execute(
                    select(Channel).order_by(Channel.created_at.asc())
                )
            )
            .scalars()
            .all()
        )
        return [_channel_dict(c) for c in channels]


def _channel_dict(c: Channel) -> dict:
    return {
        "public_id": c.public_id,
        "name": c.name,
        "enabled": c.enabled,
        "source_pool": list(c.source_pool or []),
        "voice": c.voice,
        "bili_tid": c.bili_tid,
        "desc_template": c.desc_template,
        "tags": list(c.tags or []),
        "title_style_prompt": c.title_style_prompt,
        "persona_prompt": c.persona_prompt,
        "intro_config": dict(c.intro_config or {}),
    }


@router.get("/voices")
async def voice_catalog() -> list[dict]:
    return list_voices()


@router.post("")
async def create_channel(body: ChannelBody) -> dict:
    import uuid

    from sqlalchemy import select

    key = (body.public_id or "").strip()
    if not key:
        key = uuid.uuid4().hex[:12]
    if not _KEY_RE.match(key):
        raise HTTPException(422, "key 仅允许小写字母/数字/连字符，2-64 位")
    async with session_factory() as session:
        exists = (
            await session.execute(
                select(Channel).where(Channel.public_id == key)
            )
        ).scalar_one_or_none()
        if exists is not None:
            raise HTTPException(409, f"栏目 key '{key}' 已存在")
        channel = Channel(public_id=key)
        _apply(channel, body)
        session.add(channel)
        await session.commit()
        await session.refresh(channel)
        return _channel_dict(channel)


@router.put("/{key}")
async def update_channel(key: str, body: ChannelBody) -> dict:
    from sqlalchemy import select

    async with session_factory() as session:
        channel = (
            await session.execute(select(Channel).where(Channel.public_id == key))
        ).scalar_one_or_none()
        if channel is None:
            raise HTTPException(404, f"栏目 '{key}' 不存在")
        _apply(channel, body)
        await session.commit()
        await session.refresh(channel)
        return _channel_dict(channel)


@router.delete("/{key}")
async def delete_channel(key: str) -> dict:
    from sqlalchemy import delete

    async with session_factory() as session:
        result = await session.execute(
            delete(Channel).where(Channel.public_id == key)
        )
        await session.commit()
        if result.rowcount == 0:
            raise HTTPException(404, f"栏目 '{key}' 不存在")
        return {"ok": True}
