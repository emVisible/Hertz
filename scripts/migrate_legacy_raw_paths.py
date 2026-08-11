"""一次性数据修复：越界 raw_path/cover_path 迁移到 Hertz 数据根（v0.8.1）。

背景：历史条目的 raw_path 指向前作项目目录（如 /Users/young/Code/Autarkeia/
data/raw/...），不在 Hertz 文件白名单（data_dir/output/assets_root/projects）内——
fileUrl 返回 403，导致预处理预览「成片文件缺失」。

做法：文件复制到 data/pipeline/legacy-raw/{seq}/ 并更新条目路径（幂等——
已迁移的跳过；目标已存在则直接改路径不重复复制）。
"""

import asyncio
import shutil
from pathlib import Path

from sqlalchemy import select

from backend.config import settings
from backend.models.item import Item
from backend.models.session import session_factory

_TARGET_ROOT = Path(settings.data_dir) / "pipeline" / "legacy-raw"


def _is_outside(path: str | None) -> bool:
    if not path:
        return False
    p = Path(path)
    if p.is_absolute():
        root = Path(settings.data_dir).resolve()
        try:
            resolved = p.resolve()
        except OSError:
            return False
        return root not in resolved.parents and resolved != root
    # 相对路径：legacy-raw 迁移产物（v0.8.1 曾误存相对）→ 需重写为绝对
    return "pipeline/legacy-raw/" in str(p)


def _migrate_one(item: Item, field: str, seq: int) -> bool:
    path = getattr(item, field)
    if not _is_outside(path):
        return False
    src = Path(path)
    if not src.is_absolute():
        src = Path(settings.data_dir).resolve() / src  # 相对 → 按数据根锚定
    if not src.exists():
        setattr(item, field, None)  # 源文件已不存在 → 清引用
        return True
    target_dir = _TARGET_ROOT / f"{seq}"
    target = target_dir / src.name
    target_dir.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        shutil.copy2(str(src), str(target))
    # 统一存绝对路径（与正常产物一致，fileUrl 直接可用）
    setattr(item, field, str(target.resolve()))
    return True


async def main() -> None:
    fixed = 0
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(
                    (Item.raw_path.isnot(None)) | (Item.cover_path.isnot(None))
                )
            )
        ).scalars().all()
        for item in rows:
            seq = item.seq or 0
            changed = _migrate_one(item, "raw_path", seq)
            changed = _migrate_one(item, "cover_path", seq) or changed
            if changed:
                fixed += 1
        # 重建：迁移中途置空的条目（relative→absolute 双重锚定误判不存在）——
        # 文件仍在 legacy-raw/{seq}/，按 seq 直接引用绝对路径
        legacy_dir = _TARGET_ROOT.resolve()
        if legacy_dir.is_dir():
            by_seq = {}
            for sub in legacy_dir.iterdir():
                if not sub.is_dir():
                    continue
                files = sorted(p for p in sub.iterdir() if p.is_file())
                if files:
                    by_seq[sub.name] = files[0]
            nulls = (
                await session.execute(
                    select(Item).where(
                        (Item.raw_path.is_(None)) | (Item.cover_path.is_(None))
                    )
                )
            ).scalars().all()
            for item in nulls:
                seq = str(item.seq or "")
                file = by_seq.get(seq)
                if file is not None and not item.raw_path:
                    item.raw_path = str(file)
                    fixed += 1
        if fixed:
            await session.commit()
            print(f"migrated {fixed} item(s) to {_TARGET_ROOT}")
        else:
            print("no out-of-roots paths found")


if __name__ == "__main__":
    asyncio.run(main())
