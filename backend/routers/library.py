"""Library endpoints: browse, metadata, thumbnails, file serving.

File serving uses Starlette FileResponse which supports Range requests,
so <video>/<audio> tags can stream directly from /api/library/file.
"""

import asyncio
import logging
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

logger = logging.getLogger(__name__)

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
    from backend.infrastructure.storage import file_store

    # 相对路径一律锚定 file_store.data_dir（§33 持久化路径单一真相根），
    # 不依赖后端进程 cwd——打包版/外部启动目录下相对路径同样可解析
    roots = [file_store.data_dir]
    overrides = runtime_config.load()
    custom_assets = overrides.get("assets_root")
    if custom_assets:
        roots.append(Path(custom_assets))
    roots.append(file_store.output_root())  # 产物目录（pipeline/studio）可浏览可播放
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
    raw = Path(path)
    if raw.is_absolute():
        target = Path(await APath(raw).resolve())
    else:
        # 相对路径（如 data/output/pipeline/... 产物相对引用）按数据根锚定，
        # 不依赖后端进程 cwd（§33 持久化路径单一真相根）；归一化 .. 防越界
        from backend.infrastructure.storage import file_store

        target = file_store.resolve(raw).resolve()
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


# ---------- 素材智能整理（v0.2.3，参考 Eagle AI Action） ----------

_MAX_ORGANIZE_BATCH = 20


def _extract_json(text: str) -> dict | None:
    """宽松解析 LLM 输出：优先 ```json 代码块，其次纯 JSON。"""
    import json as _json
    import re

    text = text.strip()
    match = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    candidate = match.group(1) if match else text
    try:
        data = _json.loads(candidate)
        return data if isinstance(data, dict) else None
    except ValueError:
        return None


@router.post("/ai-organize")
async def ai_organize(body: dict):
    """AI 素材整理（人工触发，走 fast 角色低费用）：为文件名/类型生成
    标签与建议文件名，返回待确认结果；应用由前端逐条确认后调 /tags、/rename。

    成本防护：每批 ≤20 条 + 仅手动触发（不自动跑，AXIOM §4.3）。
    """
    paths = body.get("paths") or []
    if not isinstance(paths, list) or not paths:
        raise HTTPException(status_code=422, detail="paths 列表必填")
    if len(paths) > _MAX_ORGANIZE_BATCH:
        raise HTTPException(status_code=422, detail=f"单批最多 {_MAX_ORGANIZE_BATCH} 条")

    targets: list[Path] = []
    for p in paths:
        target = await _ensure_allowed(str(p))
        if not target.is_file():
            raise HTTPException(status_code=422, detail=f"不是文件：{p}")
        targets.append(target)

    from backend.factory.registry import ServiceRegistry

    ai = ServiceRegistry.get().ai
    if ai is None or not ai.llm_available:
        raise HTTPException(status_code=502, detail="LLM 未配置，无法整理")

    listing = "\n".join(f"- {t.name}（{t.suffix or '无扩展名'}）" for t in targets)
    system = (
        "你是素材库整理助手。根据文件名与常见约定推断内容主题，给出整理建议。\n"
        '只输出 JSON，格式：{"items":[{"tags":["标签1","标签2"],'
        '"suggested_name":"建议文件名（含扩展名）"}]}\n'
        "数组顺序与输入一致，不要包含路径字段。规则：\n"
        "① tags 2-5 个、用中文、概括内容主题与类型；无法判断的给空数组；\n"
        "② suggested_name 简洁可读、保留扩展名；无法判断的给原文件名；\n"
        "③ 只输出 JSON，不要解释。"
    )
    from backend.ai.types import ChatMessage

    messages = [
        ChatMessage(role="system", content=system),
        ChatMessage(role="user", content=f"以下文件需要整理（按顺序对应输出）：\n{listing}"),
    ]
    try:
        text = await ai.chat_messages(messages, role="fast", max_tokens=1200)
    except Exception as exc:  # noqa: BLE001 — 可读失败（§4.2 快速失败）
        logger.error("ai-organize failed: %s", exc)
        raise HTTPException(status_code=502, detail="AI 整理失败，请稍后重试") from exc

    data = _extract_json(text)
    raw_items = (data or {}).get("items") if data else None
    if not isinstance(raw_items, list):
        raise HTTPException(status_code=502, detail="AI 返回格式无法解析")

    # 按输入顺序映射回真实路径（忽略 LLM 可能幻造的 path 字段——批次内围栏兜底）
    results = []
    for i, item in enumerate(raw_items[: _MAX_ORGANIZE_BATCH]):
        if i >= len(targets) or not isinstance(item, dict):
            continue
        tags = [str(x).strip() for x in item.get("tags") or [] if str(x).strip()][:8]
        name = str(item.get("suggested_name") or "").strip()
        results.append({"path": str(targets[i]), "tags": tags, "suggested_name": name})
    return {"results": results}


@router.post("/rename")
async def rename_file(body: dict):
    """重命名素材（AI 整理确认后执行）：sidecar 同步迁移 + 失败回滚（§33 原子性）。"""
    path = str(body.get("path") or "")
    new_name = str(body.get("new_name") or "").strip()
    if not path or not new_name:
        raise HTTPException(status_code=422, detail="path 与 new_name 必填")
    if "/" in new_name or "\\" in new_name or new_name.startswith("."):
        raise HTTPException(status_code=422, detail="文件名不合法")
    target = await _ensure_allowed(path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")

    dest = target.with_name(new_name)
    if await asyncio.to_thread(dest.exists):
        raise HTTPException(status_code=409, detail=f"目标已存在：{new_name}")

    moved: list[tuple[Path, Path]] = []
    try:
        await asyncio.to_thread(target.rename, dest)
        moved.append((target, dest))
        # sidecar 同步迁移（meta/thumb 丢失会破坏标签与缩略图）
        for suffix in (".meta.json", ".thumb.jpg"):
            src_side = Path(f"{target}{suffix}")
            if await asyncio.to_thread(src_side.exists):
                dest_side = Path(f"{dest}{suffix}")
                await asyncio.to_thread(src_side.rename, dest_side)
                moved.append((src_side, dest_side))
    except OSError as exc:
        # 回滚：主文件或 sidecar 已动 → 全部还原，保证幂等重试（§4.2 就近失败）
        for src, dst in reversed(moved):
            try:
                if await asyncio.to_thread(dst.exists):
                    await asyncio.to_thread(dst.rename, src)
            except OSError:
                logger.error("rename rollback failed for %s", dst)
        raise HTTPException(status_code=500, detail="重命名失败，已回滚") from exc
    return {"path": str(dest)}


@router.get("/duplicates")
async def find_duplicates(path: str = Query(...), limit: int = Query(120, ge=1, le=300)):
    """phash 素材查重（v0.2.3，参考 Eagle Find Duplicates）：目录内图片/视频
    按平均哈希聚类，返回相似组（仅 >1 文件的组）。ffmpeg 逐文件抽帧计算。
    limit 为「最多计算的媒体数」——先过滤媒体再截断，目录/文档不占额度。
    """
    target = await _ensure_allowed(path)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="目录不存在")

    # 扫描走线程池（§7.2 文件 IO 不阻塞事件循环）；媒体优先再截断
    entries = [
        e for e in await asyncio.to_thread(browser.scan, target, False, limit * 2)
        if e["kind"] in ("video", "image")
    ][:limit]
    from backend.pipeline.phash import compute_phash

    groups: dict[str, list[dict]] = {}
    for entry in entries:
        try:
            phash = await compute_phash(entry["path"])
        except Exception:  # noqa: BLE001 — 单文件失败跳过（查重是辅助功能）
            phash = None
        if not phash:
            continue
        groups.setdefault(phash, []).append(entry)

    duplicates = [
        {"phash": h, "files": files}
        for h, files in groups.items()
        if len(files) > 1
    ]
    return {"scanned": len(entries), "groups": duplicates}


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
