"""Docs endpoints: project-level markdown documents.

文档 = 项目文档空间：素材根目录（可配置 assets_root，默认当前项目目录）
下的 .md 文档，支持浏览 / 阅读 / 新建 / 编辑 / 删除。

路径 containment（AXIOM §22.1/§8.3）：拒绝绝对路径与越界（..）请求，
只允许 .md 文档，任何非法请求一律 4xx。
"""

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import runtime_config, settings

router = APIRouter(prefix="/docs", tags=["docs"])


def _doc_root() -> Path:
    """Document root = 素材根目录（与素材浏览根一致，AXIOM §1.2 单一真相源）。"""
    return Path(runtime_config.load().get("assets_root") or settings.data_dir).resolve()


def _resolve_doc(path: str) -> Path:
    if not path or Path(path).is_absolute():
        raise HTTPException(status_code=422, detail="path must be a relative .md path")
    if not path.lower().endswith(".md"):
        raise HTTPException(status_code=422, detail="only .md documents are allowed")
    root = _doc_root()
    target = (root / path).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(status_code=403, detail="outside document root")
    return target


@router.get("")
async def docs_index() -> dict:
    """List project documents (relative .md paths under the document root)."""
    root = _doc_root()
    if not root.is_dir():
        return {"files": []}
    files = [
        str(p.relative_to(root))
        for p in sorted(root.rglob("*.md"))
        if p.is_file() and not any(part.startswith(".") for part in p.relative_to(root).parts)
    ]
    return {"files": files}


@router.get("/content")
async def docs_content(path: str) -> dict:
    target = _resolve_doc(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="document not found")
    return {"path": path, "content": target.read_text(encoding="utf-8")}


class DocSave(BaseModel):
    path: str
    content: str


@router.post("/save")
async def docs_save(req: DocSave) -> dict:
    target = _resolve_doc(req.path)
    if target.is_dir():
        raise HTTPException(status_code=422, detail="path is a directory")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(req.content, encoding="utf-8")
    return {"path": req.path}


@router.delete("")
async def docs_delete(path: str) -> dict:
    target = _resolve_doc(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="document not found")
    target.unlink()
    return {"deleted": path}
