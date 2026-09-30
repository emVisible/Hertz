"""数据体检（v0.33）：把「库里已经烂了」变成机器先知道的一件事。

存在理由：空壳条目是**这一轮人肉点下载才发现**的——队列数字里 42% 是必然失败的
条目，而没有任何一层会主动说。源码级测试拦不住这类问题，因为它不是代码坏了，是
**数据与判据不一致**；所以必须有一条常驻的不变量检查，并且只报不改（自动改写
数据要显式跑 `scripts/quarantine-shell-items.py`）。

每条不变量都是纯查询 + 结构化结果，可单测；聚合在 `run_integrity_check()`：
写 telemetry tick（设置页/日志可见）、异常时经 `infrastructure/alerts` 单次告警，
恢复后复位（与 S4 的模型下载告警同一机制）。
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from pathlib import Path

from sqlalchemy import func, or_, select

from backend.config import settings
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.publish_queue import PHASE_HOLDING, PHASE_READY
from backend.pipeline.quality import MIN_STORY_CHARS, QUARANTINABLE_STATUSES
from backend.pipeline.service_queries import operational_filters

#: 隔离占比超过它就不正常——通常是某个采集通道整体劣化（判据变了 / 源站改版）
INVALID_SHARE_MAX = 0.2
#: 每条不变量最多带几条样本（告警文案要短，也要能直接定位）
SAMPLE_LIMIT = 3
#: 单次扫描的行数上限。**不能拿它当「够用就行」的截断**：早期版本用 2000/3000 的
#: 窗口，插入一条脏数据会把窗口尾部挤出去一条，计数纹丝不动——`count` 因此不可信，
#: 而计数正是告警与「+1/-1」自证断言的依据。样本走 samples 截断，计数走全量。
SCAN_CAP = 50_000
#: status × queue_phase 的合法组合。发布相位只允许出现在终态附近，
#: 出现 `approved` + `ready` 以外的组合说明有代码绕过了 enqueue 的门。
LEGAL_PHASE_STATUSES = (ItemStatus.APPROVED, ItemStatus.QUEUED, ItemStatus.PUBLISHED)


@dataclass
class Finding:
    name: str
    ok: bool
    count: int
    hint: str
    samples: list[dict] = field(default_factory=list)


def _sample_rows(rows: list[Item]) -> list[dict]:
    return [
        {"id": str(r.id), "title": (r.title or "")[:60], "status": r.status,
         "error_class": r.error_class or ""}
        for r in rows[:SAMPLE_LIMIT]
    ]


async def check_shell_in_pipeline() -> Finding:
    """空壳形状却**没有**隔离标：判据与数据不一致（新写入口绕过闸，或判据改过）。

    扫描范围与回填脚本同一个作者（QUARANTINABLE_STATUSES）——把 published/rejected
    也算成「不一致」会让体检永远报红、告警变成噪音。
    """
    from backend.pipeline.quality import quarantine_reason

    bad: list[dict] = []
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.archived.is_(False),
                    Item.is_invalid.is_(False),
                    Item.status.in_(QUARANTINABLE_STATUSES),
                )
                .order_by(Item.seq.desc())
                .limit(SCAN_CAP)
            )
        ).scalars().all()
    for r in rows:
        if quarantine_reason(r):
            bad.append({
                "id": str(r.id), "title": (r.title or "")[:60],
                "status": r.status, "error_class": r.error_class or "",
            })
    n = len(bad)
    return Finding(
        "shell_in_pipeline", n == 0, n,
        "有空壳未打隔离标——跑 scripts/quarantine-shell-items.py --apply",
        bad[:SAMPLE_LIMIT],
    )


async def check_video_without_media() -> Finding:
    """被标成视频/图集却没有任何可下载直链（2011 条的原始形状）。"""
    from backend.pipeline.quality import has_downloadable_media

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.archived.is_(False),
                    Item.is_invalid.is_(False),
                    Item.status.in_(QUARANTINABLE_STATUSES),
                    Item.item_type.in_(("video_raw", "image_gallery")),
                )
                .order_by(Item.seq.desc())
                .limit(SCAN_CAP)
            )
        ).scalars().all()
    offenders = [r for r in rows if not has_downloadable_media(r.media_url)]
    return Finding(
        "video_without_media", not offenders, len(offenders),
        "视频/图集条目缺媒体直链：要么分类器误标，要么该隔离",
        _sample_rows(offenders),
    )


#: 「产物类」状态（downloaded 及之后）：这几档要求磁盘上有文件。
ARTIFACT_STATUSES = (
    ItemStatus.DOWNLOADED, ItemStatus.SCORED, ItemStatus.QUEUED, ItemStatus.APPROVED,
)


def artifact_scope() -> list:
    """产物不变量的**取行范围**（v0.34 C 抽出，供测试与后续复用）。

    为什么单独成一个函数：这条不变量栽过的两个跟头都在「范围」上——原先它
    不排除 `is_invalid`（把刻意停进异常区的空壳报成产物缺失，长期红），
    又写死私有小窗口（计数不动）。范围与判据分开之后，范围这一半可以被
    直接断言，不需要靠「往共享库里插数据再看全局计数」那种顺序敏感的做法。
    """
    return [
        *operational_filters(include_archived=False, include_invalid=False),
        Item.status.in_(ARTIFACT_STATUSES),
    ]


async def check_downloaded_without_file() -> Finding:
    """downloaded 及之后的状态必须有产物文件（路径缺失=制作必然失败）。

    2026-09-28 实测后修掉两处自身缺陷（起因是它在这台机器上长期红 5 条）：

    ①**它原先不排除 `is_invalid`**。dev 库里那 5 条 offender 全部是
      `status=queued` + `error_class=invalid_media`——即 v0.33 刻意停进异常区的空壳。
      把它们算成「产物缺失」是把「我们已知它没产物」报两遍。一条长期红的报警器
      等于没有报警器，而这正是本片要消灭的形状。
    ②**窗口原先写死 `limit(500)`**，而本文件顶部 `SCAN_CAP` 的注释记着同一个坑：
      窗口尾部被新数据挤出去时计数纹丝不动——「插一条脏数据，计数 +1」的自证
      断言会因此随机失效。统一用 `SCAN_CAP`。

    「可操作范围」的判据作者是 `service_queries.operational_filters`，此处只消费不重写。
    """
    missing: list[dict] = []
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item).where(*artifact_scope()).order_by(Item.seq.desc()).limit(SCAN_CAP)
            )
        ).scalars().all()
    root = Path(str(settings.data_dir))

    def _present(raw: str) -> bool:
        """raw_path 按 data_dir 相对存储（与产物目录同语义）；绝对路径也认。

        文件系统探测放线程里：体检是异步任务，`Path.exists` 会短堵事件循环
        （ruff ASYNC240 就是为这个）。
        """
        if not raw:
            return False
        return Path(raw).exists() or (root / raw).exists()

    for r in rows:
        if r.item_type == "text_only":
            continue  # 文字产线无原片
        raw = (r.raw_path or "").strip()
        if not await asyncio.to_thread(_present, raw):
            missing.append({
                "id": str(r.id), "title": (r.title or "")[:60],
                "status": r.status, "error_class": r.error_class or "",
            })
        if len(missing) >= SAMPLE_LIMIT * 3:
            break
    return Finding(
        "downloaded_without_file", not missing, len(missing),
        "已进入下载后状态但 raw_path 缺失/文件不存在——制作会必然失败",
        missing[:SAMPLE_LIMIT],
    )


async def check_duplicate_source_id() -> Finding:
    """同一 (source, source_id) 多行 = 采集去重被绕过（重复条目会重复消耗产能）。"""
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item.source, Item.source_id, func.count().label("n"))
                .where(Item.archived.is_(False), Item.source_id != "")
                .group_by(Item.source, Item.source_id)
                .having(func.count() > 1)
                .order_by(func.count().desc())
                .limit(SAMPLE_LIMIT)
            )
        ).all()
    total = sum(int(r.n) for r in rows)
    return Finding(
        "duplicate_source_id", not rows, total,
        "存在重复入库：检查 steps/collect.py 的去重查询是否被绕过",
        [{"id": f"{r.source}:{r.source_id}", "title": f"{r.n} 行", "status": "", "error_class": ""}
         for r in rows],
    )


async def check_illegal_phase_status() -> Finding:
    """发布相位只该出现在可发布状态上（相位与状态互相矛盾=有旁路写入）。"""
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.archived.is_(False),
                    Item.queue_phase.in_((PHASE_HOLDING, PHASE_READY)),
                    Item.status.notin_(LEGAL_PHASE_STATUSES),
                )
                .order_by(Item.seq.desc())
                .limit(SAMPLE_LIMIT)
            )
        ).scalars().all()
    return Finding(
        "illegal_phase_status", not rows, len(rows),
        "queue_phase 与 status 组合非法（enqueue 之外的路径写了发布相位？）",
        _sample_rows(list(rows)),
    )


async def check_invalid_share() -> Finding:
    """隔离占比：超过阈值通常不是数据脏，而是**采集通道整体失效**。"""
    async with session_factory() as session:
        total = int(
            (await session.execute(
                select(func.count()).select_from(Item).where(Item.archived.is_(False))
            )).scalar() or 0
        )
        invalid = int(
            (await session.execute(
                select(func.count()).select_from(Item)
                .where(Item.archived.is_(False), Item.is_invalid.is_(True))
            )).scalar() or 0
        )
    share = (invalid / total) if total else 0.0
    ok = share <= INVALID_SHARE_MAX
    return Finding(
        "invalid_share", ok, invalid,
        f"隔离条目占比 {share:.0%}（阈值 {INVALID_SHARE_MAX:.0%}）——"
        "采集通道可能在整体劣化，去异常区「空壳」池看原因分布",
        [],
    )


async def check_story_without_text() -> Finding:
    """7) `item_type=text_only` 却低于正文门槛（v0.34 C 供给链可见化）。

    为什么单列一条：dev 库实测 `items.selftext` **0/5281**——文字帖的正文根本没落库
    （只有 JSON/OAuth 通道的 `_to_post` 会写 selftext，匿名 JSON 被 403 时静默降级
    到取不到正文的 RSS）。后果是 2196 条被隔离的条目里 2013 条落在情感名单，
    情感**文字**垂类的可操作供给只剩 6 条。这不是代码坏了，是上游断供，
    而断供在界面上的样子恰好和「今天没有好素材」一模一样——不说就没人分辨得出。

    正文门槛复用 `quality.MIN_STORY_CHARS`，此处不另立数字。
    """
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.archived.is_(False),
                    Item.item_type == "text_only",
                    func.length(func.coalesce(Item.selftext, "")) < MIN_STORY_CHARS,
                )
                .order_by(Item.seq.desc())
                .limit(SCAN_CAP)
            )
        ).scalars().all()
    return Finding(
        "story_without_text", not rows, len(rows),
        f"text_only 条目正文低于 {MIN_STORY_CHARS} 字：正文没落库（采集通道劣化或回填未跑）",
        _sample_rows(rows),
    )


#: 「已经离开工作区」的状态：这三处各自调 `board_store.clear_focus` 清 focus，
#: 所以带着 `focus_date` 出现在这里 = 有人绕过那三处写了 focus（spec §4.6）。
FOCUS_ORPHAN_STATUSES = (ItemStatus.REJECTED, ItemStatus.PUBLISHED)


async def check_focus_orphan() -> Finding:
    """8) `focus_date` 非空但条目已离开工作区（v0.34 B 看板）。

    为什么这条现在才成立：`archive()` / `reject()` / 发布三条路径**都调** `clear_focus`
    之后，「今天捞入的条目被拒了/归档了还占着今日」不再是正常操作，而是旁路写入的证据。
    在没那三处清理之前加这条判据，它会在用户最日常的动作为红——一条长期红的报警器
    等于没有报警器（本文件第 3 条刚为此被修过）。

    归档行要单独算：`archived` 与 `status` 是两件事（归档可以是任何状态），
    而看板的取数默认就排除归档，所以「归档却带着 focus」只能来自绕过。
    """
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(Item)
                .where(
                    Item.focus_date.isnot(None),
                    or_(
                        Item.archived.is_(True),
                        Item.status.in_(FOCUS_ORPHAN_STATUSES),
                    ),
                )
                .order_by(Item.seq.desc())
                .limit(SCAN_CAP)
            )
        ).scalars().all()
    return Finding(
        "focus_orphan", not rows, len(rows),
        "focus_date 还挂在已归档/已拒/已发的条目上：这三条路径本应清掉它",
        _sample_rows(list(rows)),
    )


CHECKS = (
    check_shell_in_pipeline,
    check_video_without_media,
    check_downloaded_without_file,
    check_duplicate_source_id,
    check_illegal_phase_status,
    check_invalid_share,
    check_story_without_text,
    check_focus_orphan,
)


async def integrity_report() -> dict:
    """跑全部不变量。任何一条抛异常都不许让整份报告消失（记成失败项）。"""
    findings: list[Finding] = []
    for check in CHECKS:
        try:
            findings.append(await check())
        except Exception as exc:  # noqa: BLE001 — 体检自身失败也要出报告
            findings.append(Finding(
                check.__name__.removeprefix("check_"), False, -1,
                f"检查本身失败：{type(exc).__name__}: {exc}", [],
            ))
    bad = [f for f in findings if not f.ok]
    return {
        "ok": not bad,
        "checked": len(findings),
        "failed": [f.name for f in bad],
        "findings": [asdict(f) for f in findings],
    }


_ALERT_KEY = "data_integrity"
_last_bad: frozenset[str] = frozenset()


async def run_integrity_check() -> dict:
    """定时/手动入口：出报告 + telemetry tick + 单次告警（恢复后复位）。"""
    from backend.infrastructure import alerts
    from backend.infrastructure.telemetry import record_tick

    report = await integrity_report()
    bad = frozenset(report["failed"])
    if bad:
        lines = [
            f"· {f['name']}：{f['count']} 条（{f['hint'][:48]}）"
            for f in report["findings"] if not f["ok"]
        ]
        alerts.notify_once(
            _ALERT_KEY,
            "🟠 数据体检发现不一致\n" + "\n".join(lines)[:600]
            + "\n\n体检只报不改；修复请显式跑 scripts/quarantine-shell-items.py",
        )
    elif _last_bad:
        alerts.reset(_ALERT_KEY)
    globals()["_last_bad"] = bad
    record_tick("data_integrity", report["ok"], 0, ",".join(report["failed"])[:120])
    return report
