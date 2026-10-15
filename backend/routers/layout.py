"""Layout 域 endpoints：超级 Markdown 模块（MD Studio）排版稿 CRUD 与导入（设计 §6）。

GET    /layout                  列表（不含 source_md 全文，updated_at 倒序）
POST   /layout                  新建（platform 枚举校验）
GET    /layout/{id}             完整单稿
PUT    /layout/{id}             局部更新（title/source_md/platform/theme_id/overrides/cover）
DELETE /layout/{id}
GET    /layout/import/docs      从 docs 空间读 md（containment 复用 docs.py 的 _resolve_doc）
GET    /layout/import/studio    从 data/output/studio/<slug>/final.md 读 Studio 产物

后端零渲染：这里只搬运 markdown 文本与配置 JSON，解析/排版/导出全在前端 mdcore。
"""

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select

from backend.infrastructure.storage import file_store
from backend.models.layout import Layout, LayoutRevision
from backend.models.session import session_factory
from backend.routers.docs import _resolve_doc

router = APIRouter(prefix="/layout", tags=["layout"])

# 可局部更新的字段（版本快照与 PUT 共用一份，别写两遍）
LAYOUT_FIELDS = ("title", "source_md", "platform", "theme_id", "overrides", "cover")

Platform = Literal["wechat", "xhs", "zhihu"]

_H1_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)


def _suggest_title(content: str, fallback: str) -> str:
    """建议标题：正文第一个一级标题，否则退回文件名/运行 slug。"""
    m = _H1_RE.search(content)
    return m.group(1) if m else fallback


def _layout_dict(layout: Layout, *, full: bool = True) -> dict:
    data = {
        "id": str(layout.id),
        "title": layout.title,
        "platform": layout.platform,
        "theme_id": layout.theme_id,
        "updated_at": layout.updated_at,
        "deleted_at": layout.deleted_at,
    }
    if full:
        data.update(
            {
                "source_md": layout.source_md,
                "source_ref": layout.source_ref,
                "overrides": dict(layout.overrides or {}),
                "cover": dict(layout.cover or {}),
                "created_at": layout.created_at,
                "deleted_at": layout.deleted_at,
            }
        )
    return data


class LayoutCreate(BaseModel):
    title: str = Field(default="", max_length=255)
    source_md: str = ""
    source_ref: str | None = Field(default=None, max_length=1024)
    platform: Platform
    theme_id: str = Field(default="", max_length=128)
    overrides: dict = Field(default_factory=dict)
    cover: dict = Field(default_factory=dict)


class LayoutUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    source_md: str | None = None
    platform: Platform | None = None
    theme_id: str | None = Field(default=None, max_length=128)
    overrides: dict | None = None
    cover: dict | None = None


@router.get("")
async def list_layouts(deleted: bool = False) -> list[dict]:
    """稿件列表。默认只给**活着的**稿；`deleted=true` 给回收站那一摞。

    为什么要回收站：原来这个 DELETE 是硬删，点一下"删除"就没了——没有后悔药、
    没有历史、点错一次无法挽回。这是"用界面操作就能造成不可逆损失"的典型，
    而数据安全的最低要求是**误操作可逆**。
    """
    async with session_factory() as session:
        stmt = select(Layout).order_by(Layout.updated_at.desc())
        stmt = (
            stmt.where(Layout.deleted_at.isnot(None))
            if deleted
            else stmt.where(Layout.deleted_at.is_(None))
        )
        rows = (await session.execute(stmt)).scalars().all()
        return [_layout_dict(row, full=False) for row in rows]


@router.post("")
async def create_layout(body: LayoutCreate) -> dict:
    async with session_factory() as session:
        layout = Layout(
            title=body.title,
            source_md=body.source_md,
            source_ref=(body.source_ref or "").strip() or None,
            platform=body.platform,
            theme_id=body.theme_id,
            overrides=body.overrides,
            cover=body.cover,
        )
        session.add(layout)
        await session.commit()
        await session.refresh(layout)
        return _layout_dict(layout)


async def _get_layout(session, layout_id: UUID) -> Layout:
    layout = (
        await session.execute(select(Layout).where(Layout.id == layout_id))
    ).scalar_one_or_none()
    if layout is None:
        raise HTTPException(status_code=404, detail="layout not found")
    return layout


async def _get_live_layout(session, layout_id: UUID) -> Layout:
    """取一篇活着的稿。已删的按 404 处理——不然就能编辑一篇"已删"的稿，
    保存又把它写活，回收站就形同虚设。"""
    layout = await _get_layout(session, layout_id)
    if layout.deleted_at is not None:
        raise HTTPException(status_code=404, detail="layout is in the recycle bin")
    return layout


@router.get("/import/docs")
async def import_from_docs(path: str) -> dict:
    """从 docs 空间导入：containment 规则与 docs.py 完全一致（复用其 _resolve_doc）。"""
    target = _resolve_doc(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="document not found")
    content = target.read_text(encoding="utf-8")
    return {
        "path": path,
        "content": content,
        "suggested_title": _suggest_title(content, Path(path).stem),
    }


@router.get("/import/studio")
async def import_from_studio(run: str) -> dict:
    """从 Studio 产物目录导入 final.md；slug fail-closed（.. / / \\ 一律 422）。"""
    if not run or ".." in run or "/" in run or "\\" in run:
        raise HTTPException(status_code=422, detail="invalid run slug")
    studio_root = (file_store.output_root() / "studio").resolve()
    target = (studio_root / run / "final.md").resolve()
    if studio_root not in target.parents:
        raise HTTPException(status_code=422, detail="invalid run slug")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="studio final.md not found")
    content = target.read_text(encoding="utf-8")
    return {
        "run": run,
        "content": content,
        "suggested_title": _suggest_title(content, run),
    }


@router.get("/{layout_id}")
async def get_layout(layout_id: UUID) -> dict:
    async with session_factory() as session:
        # 单篇取用按「已删 = 404」处理：编辑器不许打开一篇已删的稿，
        # 否则一次自动保存就把它写活，回收站形同虚设
        return _layout_dict(await _get_live_layout(session, layout_id))


async def _snapshot(session, layout: Layout) -> LayoutRevision:
    """把当前内容落一份版本快照（更新**之前**存，所以历史里能回到改之前）。

    seq 用该稿内递增：查"最近 N 版"直接 ORDER BY seq DESC LIMIT N，
    不必按时间戳猜（同一秒两次保存会撞时间戳）。
    """
    last = (
        await session.execute(
            select(func.max(LayoutRevision.seq)).where(LayoutRevision.layout_id == layout.id)
        )
    ).scalar()
    revision = LayoutRevision(
        layout_id=layout.id,
        seq=(last or 0) + 1,
        title=layout.title,
        source_md=layout.source_md,
        source_ref=layout.source_ref,
        platform=layout.platform,
        theme_id=layout.theme_id,
        overrides=dict(layout.overrides or {}),
        cover=dict(layout.cover or {}),
    )
    session.add(revision)
    await session.flush()
    return revision


@router.put("/{layout_id}")
async def update_layout(layout_id: UUID, body: LayoutUpdate) -> dict:
    async with session_factory() as session:
        layout = await _get_live_layout(session, layout_id)
        changed = any(getattr(body, f) is not None for f in LAYOUT_FIELDS)
        if changed:
            # 快照存的是**改之前**的内容：用户改砸了要能退回去，存改后的就没意义了
            await _snapshot(session, layout)
        for field in LAYOUT_FIELDS:
            value = getattr(body, field)
            if value is not None:
                setattr(layout, field, value)
        await session.commit()
        await session.refresh(layout)
        return _layout_dict(layout)


@router.delete("/{layout_id}")
async def delete_layout(layout_id: UUID) -> dict:
    """软删：进回收站，不再出现在列表里，但**随时能捞回来**。"""
    async with session_factory() as session:
        layout = await _get_live_layout(session, layout_id)
        await _snapshot(session, layout)
        layout.deleted_at = datetime.now(UTC)
        await session.commit()
        return {"ok": True, "deleted_at": layout.deleted_at}


@router.post("/{layout_id}/restore")
async def restore_layout(layout_id: UUID) -> dict:
    """从回收站捞回来，内容原样。"""
    async with session_factory() as session:
        layout = await _get_layout(session, layout_id)
        if layout.deleted_at is None:
            return _layout_dict(layout)
        layout.deleted_at = None
        await session.commit()
        await session.refresh(layout)
        return _layout_dict(layout)


@router.post("/{layout_id}/purge")
async def purge_layout(layout_id: UUID) -> dict:
    """**真删**（不可逆）。回收站里的稿子只能显式清空，不做自动过期——
    「30 天后自动删」这种默认才是数据损失的开始。"""
    async with session_factory() as session:
        layout = await _get_layout(session, layout_id)
        if layout.deleted_at is None:
            raise HTTPException(status_code=400, detail="layout is not deleted; use DELETE first")
        await session.execute(
            sa_delete(LayoutRevision).where(LayoutRevision.layout_id == layout.id)
        )
        await session.delete(layout)
        await session.commit()
        return {"ok": True}


@router.get("/{layout_id}/revisions")
async def list_revisions(layout_id: UUID, limit: int = 20) -> dict:
    """版本历史（最近的在前）。跨会话的最后一道防线：内存撤销救不了"重启之后想退回去"。"""
    async with session_factory() as session:
        await _get_layout(session, layout_id)
        rows = (
            (
                await session.execute(
                    select(LayoutRevision)
                    .where(LayoutRevision.layout_id == layout_id)
                    .order_by(LayoutRevision.seq.desc())
                    .limit(max(1, min(limit, 100)))
                )
            )
            .scalars()
            .all()
        )
        return {
            "revisions": [
                {
                    "seq": r.seq,
                    "title": r.title,
                    "created_at": r.created_at,
                    "preview": (r.source_md or "")[:120],
                    "chars": len(r.source_md or ""),
                }
                for r in rows
            ]
        }


@router.post("/{layout_id}/revisions/{seq}/restore")
async def restore_revision(layout_id: UUID, seq: int) -> dict:
    """回到某个历史版本。**先给当前内容再存一份快照**——
    否则"回到旧版"本身就是一次不可逆操作，用户会第二次踩坑。"""
    async with session_factory() as session:
        layout = await _get_live_layout(session, layout_id)
        revision = (
            await session.execute(
                select(LayoutRevision).where(
                    LayoutRevision.layout_id == layout_id, LayoutRevision.seq == seq
                )
            )
        ).scalar_one_or_none()
        if revision is None:
            raise HTTPException(status_code=404, detail="revision not found")
        await _snapshot(session, layout)
        layout.title = revision.title
        layout.source_md = revision.source_md
        layout.source_ref = revision.source_ref
        layout.platform = revision.platform
        layout.theme_id = revision.theme_id
        layout.overrides = dict(revision.overrides or {})
        layout.cover = dict(revision.cover or {})
        await session.commit()
        await session.refresh(layout)
        return _layout_dict(layout)
