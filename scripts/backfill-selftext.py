#!/usr/bin/env python3
"""正文回填（v0.34 C-run）：把异常区里的文字帖捞回可操作供给。

为什么需要它（实测，见 docs/ROADMAP.md 在飞段）：`items.selftext` 在 dev 库
**0/5281** —— 只有 JSON/OAuth 通道的 `_to_post` 会写正文，而匿名 JSON 被 403 时
采集**静默降级**到取不到正文的 RSS。后果是隔离池 2196 条里 2013 条落在情感名单、
1982 条来自文字为主子版，而未隔离的同子版只剩 6 条：情感文字垂类的弹药不是没有，
是没上车。2196 条**全部带 `source_id`**，所以可按 id 批量取回。

三条纪律：
1. **默认干跑**，`--apply` 才写库（照 `quarantine-shell-items.py` 的形状）；
2. 清标动作一律走 `quality.reassess()`——脚本自己写 `is_invalid=False` 就是
   隔离标记的第二个作者；
3. 出网不通就别开始：先探一次端点，拿到 `000` 直接退出并说明，
   **不许**用干跑冒充「回填完成了」。

用法：
    uv run python scripts/backfill-selftext.py                 # 干跑，看会改什么
    uv run python scripts/backfill-selftext.py --apply         # 真写
    uv run python scripts/backfill-selftext.py --apply --limit 5   # 小批试跑
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from backend.models.item import Item  # noqa: E402
from backend.models.session import session_factory  # noqa: E402
from backend.pipeline import quality  # noqa: E402

#: Reddit /api/info.json 单次上限就是 100 个 id，别写成 200 然后静默丢一半
BATCH = 100
#: 单轮请求上限（防跑飞；20 请求 = 2000 条）。回填是运维动作，不是一次性大扫除。
MAX_REQUESTS = 20
UA = "Hertz/0.34 (sentiment supply backfill)"


async def _candidates(session, limit: int):
    """回填候选：被隔离、且「缺的是正文而不是媒体」的那批。

    判据直接读 quality（唯一作者）——脚本不许再抄一份 shell_reason 的近似版，
    否则筛出来的和清标的对不上。
    """
    rows = (
        (
            await session.execute(
                select(Item)
                .where(
                    Item.is_invalid.is_(True),
                    Item.archived.is_(False),
                    Item.source == "reddit",
                    Item.source_id.isnot(None),
                    func.length(func.coalesce(Item.selftext, "")) < quality.MIN_STORY_CHARS,
                )
                .order_by(Item.seq.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [r for r in rows if quality.shell_reason(media_url=r.media_url, selftext=r.selftext)]


async def _fetch(selftext_by_id: dict[str, str], ids: list[str], token: str | None) -> int:
    """按 t3_ id 批量取正文，返回**请求数**（调用方据此封顶）。

    代理一律走 `net.system_proxy`（与 `RedditCollector` 同一个作者）：本机和
    OAuth 域都要靠它出网，原先按 URL 前缀只给匿名通道挂代理是第二套判据，
    结果是「配了凭证反而不走代理」——通道一多就这样各写一半。
    """
    from backend.infrastructure.net import system_proxy  # 代理判定唯一作者

    ids = ids[:BATCH]
    joined = ",".join(f"t3_{i}" for i in ids)
    if token:
        url, headers = (
            "https://oauth.reddit.com/api/info.json",
            {"Authorization": f"Bearer {token}", "User-Agent": UA},
        )
    else:
        url, headers = "https://www.reddit.com/api/info.json", {"User-Agent": UA}
    async with httpx.AsyncClient(timeout=30, headers=headers, proxy=system_proxy()) as client:
        resp = await client.get(url, params={"id": joined, "raw_json": 1, "limit": len(ids)})
        if resp.status_code != 200:
            print(f"  · 批次 HTTP {resp.status_code}（跳过该批，不中止整轮）")
            return 1
        for child in (resp.json().get("data") or {}).get("children") or []:
            data = child.get("data") or {}
            pid = str(data.get("id") or "")
            text = str(data.get("selftext") or "").strip()
            if pid and text:
                selftext_by_id[pid] = text
    return 1


async def _probe(token: str | None) -> tuple[bool, str]:
    """出网探针：一次最小请求，判断「这一轮到底能不能开始」。

    为什么必须有：docstring 承诺「拿到 000 直接退出」，没有这一步就是文档替
    代码代言。更重要的是**拿不到数据时必须退出而不是报 0 条候选**——否则
    「没有候选」既可能是「已经回填完」也可能是「根本连不上」，两者在输出里
    长得一样，而运维会按前者决定下一步。
    """
    from backend.infrastructure.net import system_proxy

    url = (
        "https://oauth.reddit.com/api/info.json?id=t3_1"
        if token
        else "https://www.reddit.com/r/test.json?limit=1"
    )
    headers = {"User-Agent": UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        async with httpx.AsyncClient(
            timeout=15, headers=headers, proxy=system_proxy()
        ) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        return False, f"{type(exc).__name__}: {str(exc)[:80]}"
    if resp.status_code in (200, 401, 403, 404):
        # 401/403/404 也是「连上了且源站答了」：能判出网，具体能不能拿到正文由计数说话
        return True, f"HTTP {resp.status_code}"
    return False, f"HTTP {resp.status_code}"


async def run(apply: bool, limit: int) -> int:
    from backend.pipeline.collectors.reddit import ensure_reddit_token

    token = await ensure_reddit_token()  # 未配置凭证时返回 None（匿名通道易被 403）
    ok, detail = await _probe(token)
    print(f"出网探针（{'oauth' if token else '匿名'} 通道）：{detail}")
    if not ok:
        print(
            "❌ 连不上源站，本轮**不开始**：既不写库也不报「没有候选」。\n"
            "   0 条候选有两种样子（已回填完 / 根本连不上），本脚本拒绝替运维猜哪一种。"
        )
        return 2
    async with session_factory() as session:
        rows = await _candidates(session, limit)
    print(
        f"回填候选 {len(rows)} 条；凭证 {'已配置' if token else '未配置（匿名通道，可能大量 403）'}"
    )
    if not rows:
        print("没有候选——要么已回填过，要么隔离原因不是「缺正文」。")
        return 0

    stats: Counter[str] = Counter()
    selftext_by_id: dict[str, str] = {}
    pending = [r for r in rows if r.source_id]
    requests_made = 0
    for start in range(0, len(pending), BATCH):
        if requests_made >= MAX_REQUESTS:
            print(f"  · 达到单轮上限 {MAX_REQUESTS} 请求，剩余 {len(pending) - start} 条下轮再跑")
            break
        chunk = pending[start : start + BATCH]
        try:
            requests_made += await _fetch(selftext_by_id, [r.source_id for r in chunk], token)
        except httpx.HTTPError as exc:
            # 网络失败是一类结果，不是崩溃：整轮结论要能标成「未闭合」而不是消失
            print(
                f"  · 批次网络失败 {type(exc).__name__}: {str(exc)[:80]}（计入 error，继续下一批）"
            )
            stats["error"] += 1
            continue
        await asyncio.sleep(1.5)  # 节流：批量打 Reddit 会被限流，限流会冻整域

    async with session_factory() as session:
        for row in pending:
            fresh = selftext_by_id.get(row.source_id or "")
            if not fresh:
                stats["not_found"] += 1
                continue
            live = await session.get(Item, row.id)
            if live is None:
                stats["not_found"] += 1
                continue
            live.selftext = fresh
            if apply:
                # 清标只发生在 quality 里；这里只填正文
                if quality.reassess(live):
                    stats["recovered"] += 1
                else:
                    stats["still_shell"] += 1
            else:
                stats["would_recover" if quality.reassess(live) else "still_shell"] += 1
            if apply:
                await session.commit()
            else:
                await session.rollback()

    async with session_factory() as session:
        live_discovered = (
            await session.execute(
                select(func.count())
                .select_from(Item)
                .where(
                    Item.status == "discovered",
                    Item.is_invalid.is_(False),
                    Item.archived.is_(False),
                )
            )
        ).scalar()

    print(f"\n分类结果：{dict(stats)}")
    print(f"当前未评分活口（discovered 且未隔离未归档）= {live_discovered}")
    print("模式：" + ("已写库（--apply）" if apply else "干跑（未写库；加 --apply 才写）"))
    if stats.get("error"):
        print("⚠️ 有批次网络失败：本轮结论不完整，别当成「回填完成」——修复网络后重跑同一命令。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="真写库（默认只干跑）")
    ap.add_argument("--limit", type=int, default=2000, help="本轮最多处理多少条（默认 2000）")
    args = ap.parse_args()
    return asyncio.run(run(args.apply, args.limit))


if __name__ == "__main__":
    raise SystemExit(main())
