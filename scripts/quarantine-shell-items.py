"""空壳条目回填隔离（v0.33）：按 `pipeline/quality` 的同一份判据标注历史数据。

为什么需要它：源头闸只能阻止**新**空壳进来；库里已有的 2011 条（实测：
`media_url == source_url` 且 1989 条 selftext 为空）不会自己消失，它们继续被
`counts()` 计成可操作的 discovered 数据，被点一次就是一次 403。

判据不在这里重写第二遍——`quality.shell_reason` 是唯一作者，脚本只是它的应用器，
所以「闸」与「回填」永远不会判得不一样。

用法：
    uv run python scripts/quarantine-shell-items.py            # 干跑：只报数与抽样
    uv run python scripts/quarantine-shell-items.py --apply    # 真写库
    uv run python scripts/quarantine-shell-items.py --restore  # 撤销全部隔离（回到未判定前）
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import func, select

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.quality import (
    QUARANTINABLE_STATUSES,
    shell_reason,
    stamp,
)


async def _counts() -> dict[str, int]:
    async with session_factory() as session:
        rows = await session.execute(
            select(Item.status, func.count())
            .where(Item.archived.is_(False), Item.is_invalid.is_(False))
            .group_by(Item.status)
        )
        return {str(s): int(n) for s, n in rows.all()}


async def main(apply: bool, restore: bool) -> None:
    before = await _counts()
    async with session_factory() as session:
        if restore:
            rows = (
                await session.execute(select(Item).where(Item.is_invalid.is_(True)))
            ).scalars().all()
            print(f"撤销隔离：{len(rows)} 条")
            for r in rows:
                r.is_invalid = False
                if (r.error_class or "") == "invalid_media":
                    r.error_class = ""
                    r.error = None
        else:
            # 只扫「还会被产线取走」的状态：终态条目即便形状像空壳也不能标
            # （published/rejected 的数字进看板与审核统计，实测 289 条）
            rows = (
                await session.execute(
                    select(Item)
                    .where(
                        Item.archived.is_(False),
                        Item.is_invalid.is_(False),
                        Item.status.in_(QUARANTINABLE_STATUSES),
                    )
                    .order_by(Item.seq.desc())
                )
            ).scalars().all()
            hits = [r for r in rows if shell_reason(media_url=r.media_url, selftext=r.selftext)]
            print(f"扫描 {len(rows)} 条在产线条目 → 判为空壳 {len(hits)} 条")
            for r in hits[:10]:
                print(f"  · {r.id} [{r.status}] {(r.title or '')[:34]}")
                print(f"      media_url={(r.media_url or '')[:70]!r}")
            if not apply:
                print("（干跑，未写库。加 --apply 才生效）")
                return
            for r in hits:
                stamp(r)  # 与采集入口同一份动作，不在此重写判据
        await session.commit()

    after = await _counts()
    print("--- counts() 可操作口径：前 → 后 ---")
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k, 0), after.get(k, 0)
        flag = "" if b == a else f"  ← 差 {a - b:+d}"
        print(f"  {k:<12}{b:>6} → {a:>6}{flag}")

    after = await _counts()
    print("--- counts() 可操作口径：前 → 后 ---")
    for k in sorted(set(before) | set(after)):
        b, a = before.get(k, 0), after.get(k, 0)
        flag = "" if b == a else f"  ← 差 {a - b:+d}"
        print(f"  {k:<12}{b:>6} → {a:>6}{flag}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的写库（默认只干跑）")
    ap.add_argument("--restore", action="store_true", help="撤销全部隔离标记")
    args = ap.parse_args()
    asyncio.run(main(args.apply, args.restore))
