"""素材重命名域（v0.22.x B 系下沉，自 routers/library.py 迁出）。

职责单一：主文件 + sidecar（meta.json/thumb.jpg）原子迁移与失败回滚。
路由层只保留：输入校验（路径围栏/文件名合法性/存在性）与 HTTP 语义转译。
"""

import asyncio
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_SIDECAR_SUFFIXES = (".meta.json", ".thumb.jpg")


async def rename_with_sidecars(target: Path, new_name: str) -> Path:
    """重命名主文件并同步迁移 sidecar；任一步失败全部还原（§33 原子性）。

    返回新路径；目标已存在抛 FileExistsError（调用方转 409）；
    文件系统操作失败抛 OSError（调用方转 500）。
    """
    dest = target.with_name(new_name)
    if await asyncio.to_thread(dest.exists):
        raise FileExistsError(f"目标已存在：{new_name}")

    moved: list[tuple[Path, Path]] = []
    try:
        await asyncio.to_thread(target.rename, dest)
        moved.append((target, dest))
        # sidecar 同步迁移（meta/thumb 丢失会破坏标签与缩略图）
        for suffix in _SIDECAR_SUFFIXES:
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
        raise OSError("重命名失败，已回滚") from exc
    return dest
