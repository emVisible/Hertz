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
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.infrastructure.storage import file_store
from backend.models.layout import Layout
from backend.models.session import session_factory
from backend.routers.docs import _resolve_doc

router = APIRouter(prefix="/layout", tags=["layout"])

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
    }
    if full:
        data.update(
            {
                "source_md": layout.source_md,
                "source_ref": layout.source_ref,
                "overrides": dict(layout.overrides or {}),
                "cover": dict(layout.cover or {}),
                "created_at": layout.created_at,
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
async def list_layouts() -> list[dict]:
    async with session_factory() as session:
        layouts = (
            (await session.execute(select(Layout).order_by(Layout.updated_at.desc())))
            .scalars()
            .all()
        )
        return [_layout_dict(l, full=False) for l in layouts]


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
        return _layout_dict(await _get_layout(session, layout_id))


@router.put("/{layout_id}")
async def update_layout(layout_id: UUID, body: LayoutUpdate) -> dict:
    async with session_factory() as session:
        layout = await _get_layout(session, layout_id)
        for field in ("title", "source_md", "platform", "theme_id", "overrides", "cover"):
            value = getattr(body, field)
            if value is not None:
                setattr(layout, field, value)
        await session.commit()
        await session.refresh(layout)
        return _layout_dict(layout)


@router.delete("/{layout_id}")
async def delete_layout(layout_id: UUID) -> dict:
    async with session_factory() as session:
        layout = await _get_layout(session, layout_id)
        await session.delete(layout)
        await session.commit()
        return {"ok": True}
