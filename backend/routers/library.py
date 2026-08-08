"""Library endpoints: browse, metadata, thumbnails, file serving.

File serving uses Starlette FileResponse which supports Range requests,
so <video>/<audio> tags can stream directly from /api/library/file.
"""

import asyncio
from pathlib import Path

from anyio import Path as APath
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import select

from backend.config import settings
from backend.library.browser import LibraryBrowser
from backend.library.metadata import probe_media
from backend.library.thumbnails import generate_thumbnail
from backend.models.download import Project
from backend.models.session import session_factory

router = APIRouter(prefix="/library", tags=["library"])

browser = LibraryBrowser()


async def _allowed_roots() -> list[Path]:
    """Browsable roots: 素材根目录（可配置，默认 data_dir）+ 项目目录。

    tag 系统替代固定文件夹解析。Desktop app grants the user control over
    their own machine, but the API must not become an unauthenticated
    arbitrary-file reader — paths outside the allowed roots are rejected
    (AXIOM §8.1/§8.3).
    """
    from backend.config import runtime_config

    roots = [Path(runtime_config.load().get("assets_root") or settings.data_dir)]
    async with session_factory() as session:
        result = await session.execute(select(Project.path))
        roots.extend(Path(p) for p in result.scalars().all() if p)
    resolved: list[Path] = []
    for r in roots:
        try:
            resolved.append(r.resolve())
        except OSError:
            continue
    return resolved


async def _ensure_allowed(path: str) -> Path:
    target = Path(await APath(path).resolve())
    for root in await _allowed_roots():
        if target == root or root in target.parents:
            return target
    raise HTTPException(status_code=403, detail=f"path outside allowed roots: {target}")


@router.get("/projects")
async def list_projects():
    async with session_factory() as session:
        result = await session.execute(select(Project).order_by(Project.name))
        return [
            {"id": str(p.id), "name": p.name, "path": p.path} for p in result.scalars().all()
        ]


@router.post("/projects")
async def create_project(body: dict):
    name = (body.get("name") or "").strip()
    path = (body.get("path") or "").strip()
    if not name or not path:
        raise HTTPException(status_code=422, detail="name and path required")
    from sqlalchemy.exc import IntegrityError

    async with session_factory() as session:
        project = Project(name=name, path=path)
        session.add(project)
        try:
            await session.commit()
        except IntegrityError as exc:
            await session.rollback()
            raise HTTPException(status_code=409, detail=f"project already exists: {name}") from exc
        await session.refresh(project)
        return {"id": str(project.id), "name": project.name, "path": project.path}


@router.get("/roots")
async def list_roots():
    from backend.config import runtime_config
    from backend.infrastructure.storage import file_store

    # 全部返回绝对路径：前端面包屑/深链用 root 做前缀拼接，
    # 相对路径会拼出 data/Users/... 这类无效路径（AXIOM §33 锚定链）
    base = (settings.data_dir / "projects").resolve()
    root_override = runtime_config.load().get("assets_root")
    root = await APath(Path(root_override or settings.data_dir)).resolve()
    return {
        "base": str(base),
        "root": str(root),
        "output": str(file_store.output_root()),
        "downloads": str((settings.data_dir / "downloads").resolve()),
        "tree": browser.list_roots(base),
    }


@router.post("/tags")
async def set_tags(body: dict):
    """给素材打标（tag 系统）：写入 `<path>.meta.json` sidecar（合并保留其他字段）。"""
    path = str(body.get("path") or "")
    raw_tags = body.get("tags") or []
    if not path or not isinstance(raw_tags, list):
        raise HTTPException(status_code=422, detail="path and tags[] required")
    target = await _ensure_allowed(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    from backend.library.browser import write_tags

    meta = write_tags(target, [str(t) for t in raw_tags])
    return {"path": path, "tags": meta.get("tags", [])}


@router.get("/scan")
async def scan(path: str = Query(...), limit: int = Query(500, ge=1, le=2000)):
    target = await _ensure_allowed(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    return {"path": str(target), "entries": browser.scan(target, limit=limit)}


@router.get("/search")
async def search_assets(
    q: str = Query(..., min_length=1, max_length=100),
    limit: int = Query(20, ge=1, le=100),
):
    """素材全局搜索（v0.2.3 ⌘K 命令面板）：允许根内按文件名/标签模糊匹配。"""
    roots = await _allowed_roots()
    return {"entries": await asyncio.to_thread(browser.search, roots, q, limit)}


@router.get("/info")
async def info(path: str = Query(...)):
    target = await _ensure_allowed(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    entry = browser.info(target)
    if entry and entry["kind"] in ("video", "audio"):
        entry["media"] = await probe_media(target)
    return entry


@router.get("/thumbnail")
async def thumbnail(path: str = Query(...)):
    target = await _ensure_allowed(path)
    thumb = APath(f"{target}.thumb.jpg")
    if not await thumb.exists():
        generated = await generate_thumbnail(target)
        if generated is None:
            raise HTTPException(status_code=404, detail="no thumbnail available")
        thumb = generated
    return FileResponse(str(thumb))


@router.get("/file")
async def file(path: str = Query(...)):
    target = await _ensure_allowed(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(target))


@router.delete("/file")
async def delete_file(path: str = Query(...)):
    """Delete a file inside the allowed roots (Assets context menu)."""
    target = await _ensure_allowed(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    await asyncio.to_thread(target.unlink)
    thumb = Path(f"{target}.thumb.jpg")
    if await asyncio.to_thread(thumb.exists):
        await asyncio.to_thread(thumb.unlink)
    return {"deleted": str(target)}
