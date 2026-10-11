"""PipelineService 查询与看板域（v0.16 架构拆分，D-168 清偿）。

纯结构移动：方法自 service.py 原样搬入 Mixin，零行为变化；
PipelineService 组合全部 Mixin，外部 import 路径不变。
"""

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, not_, select

from backend.models.item import Item, ItemStatus
from backend.models.pipeline import SourceState
from backend.models.session import session_factory
from backend.models.system import JobRun
from backend.pipeline.category import theme_subreddits
from backend.pipeline.quality import (
    MATERIAL_TIERS,
    MIN_STORY_CHARS,
    MISSING_METRIC_VALUE,
    QUALITY_TIERS,
    QUALITY_UNFILLED,
)

logger = logging.getLogger(__name__)



def operational_filters(*, include_archived: bool, include_invalid: bool) -> list:
    """流水线可操作视图的统一过滤条件（v0.33）。

    `counts()` 与 `list_items()` 必须走同一份条件：两侧各写一次就会漂移成
    「列表里没有、数字里还在」——那正是空壳条目最伤人的表现（用户照着数字
    做批量操作）。归档（备用库）与隔离（异常区）是两个独立开关，语义不同。
    """
    conditions: list = []
    if not include_archived:
        conditions.append(Item.archived.is_(False))
    if not include_invalid:
        conditions.append(Item.is_invalid.is_(False))
    return conditions


def axis_filters(*, theme: str | None, quality: str | None, has_text: bool | None,
                 material: str | None = None) -> list:
    """四条筛选轴的统一条件构造：主题轴 / 质量轴 / 正文有无轴 / 素材类型轴。

    与 `operational_filters()` 同一套纪律：`list_items()` 与 `items_facets()` 共用
    这一份，谁也不许自己再拼一次 WHERE。分开写两遍就会漂成「列表里少了两条、
    数字还是老样子」——而 facets 存在的意义正是给用户报「命中 X / 全量 Y」。

    阈值/名单不在这里：成员名单查 `category.THEME_SUBREDDITS`，质量阈值、缺值哨兵
    与正文门槛查 `quality.QUALITY_TIERS` / `quality.QUALITY_UNFILLED` /
    `quality.MISSING_METRIC_VALUE` / `quality.MIN_STORY_CHARS`，素材类型档查
    `quality.MATERIAL_TIERS`，此处只负责把它们拼成条件。
    未知 theme | quality | material → ValueError（「名单没配」不能伪装成
    「今天没有这类内容」（空集就是那种伪装）。

    `material` 与另三轴不同：它是**划分**（三档互斥且并起来恒等于分母），
    而 `quality` 是分级且存在第四格「缺值」——所以 `items_facets` 只需把它带进
    `hit`，不另开 `by_material` 分面。
    """
    conditions: list = []
    if theme is not None:
        conditions.append(Item.subreddit.in_(sorted(theme_subreddits(theme))))
    if material is not None:
        item_type = MATERIAL_TIERS.get(material)
        if item_type is None:
            raise ValueError(
                f"unknown material tier '{material}'"
                f"（可选：{sorted(MATERIAL_TIERS)}）"
            )
        conditions.append(Item.item_type == item_type)
    if quality is not None:
        if quality == QUALITY_UNFILLED:
            # 「分数没采到」单独成一档：两个字段一起为 0 是采集缺字段，不是低质量
            # （实测占未评分活口 17.2%）。让它们被三档静默排除就会把「无从判断」
            # 伪装成「质量不行」，见 quality.QUALITY_UNFILLED 的注释。
            conditions.append(Item.reddit_score == MISSING_METRIC_VALUE)
            conditions.append(Item.upvote_ratio == MISSING_METRIC_VALUE)
        else:
            tier = QUALITY_TIERS.get(quality)
            if tier is None:
                raise ValueError(
                    f"unknown quality tier '{quality}'"
                    f"（可选：{sorted(QUALITY_TIERS) + [QUALITY_UNFILLED]}）"
                )
            conditions.append(Item.reddit_score >= tier["min_score"])
            conditions.append(Item.upvote_ratio >= tier["min_ratio"])
    if has_text is not None:
        # selftext 为 NULL 的绝大多数存量条目算「无正文」：coalesce 之后
        # length('')=0，两档互补且不重叠，with+without 恒等于分母。
        enough = func.length(func.coalesce(Item.selftext, "")) >= MIN_STORY_CHARS
        conditions.append(enough if has_text else not_(enough))
    return conditions


def utc_instant(value: str) -> datetime:
    """把前端下发的 ISO 时刻统一成 **UTC 带时区** datetime（比较发生在 SQL 层）。

    唯一作者：`list_items` 的区间条件与看板端点回给界面的 ISO 串都走这里，
    两处各写一遍解析就会漂成「SQL 筛了 A 区间、界面按 B 区间分列」。

    为什么不直接比字符串：`published_at` 存的是 tz-aware UTC，序列化形如
    `...+00:00`；前端习惯写 `...Z`。两者字典序在 `+`(0x2B) 与 `Z`(0x5A) 处会翻
    边界，日切那一条就归错列——归错列的看板和「今天没发」在数字上分不出来。
    时区语义只在「前端算区间」这一处（spec §4.1），后端只做归一化不做推断。
    """
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


class QueriesMixin:
    # ---------- queries ----------

    async def list_items(
        self, status: str | None = None, limit: int = 50, source: str | None = None,
        include_archived: bool = False, include_invalid: bool = False,
        theme: str | None = None, quality: str | None = None, has_text: bool | None = None,
        material: str | None = None,
        focus_date: str | None = None,
        published_from: str | None = None, published_to: str | None = None,
    ) -> list[dict]:
        """条目列表；status 支持逗号分隔多状态（wave13：前端单查询聚合阶段队列）。
        排序：入库序号 seq desc（v0.3.1——同批 created_at 相同，seq 才是真实先后）。
        v0.5 A：QUEUED 条目标注相似内容（phash 汉明 ≤5，排除同 source_id 同源）。
        wave10：默认排除 archived（备用库用独立 archived_items 查询）。
        v0.33：默认排除 is_invalid（空壳只出现在异常区，不再冒充可操作数据）。
        v0.34 A：三条筛选轴 theme/quality/has_text（服务端筛，见 `axis_filters`）。
        v0.34 B（看板取数）：`focus_date` = 今天捞入的那批；`published_from/to` =
          发布时刻落在区间内。**这两个条件必须在这一层**，因为看板列的「唯一作者」
          纪律是「条目怎么查只有一个地方」——`board.py` 只分列不写 SQL。
          发布列尤其不能靠 `limit` + `seq desc` 截断：老条目今天才发布，按入库序
          截窗口会**静默漏掉**它，而漏掉的数字看起来和「今天没发」一模一样。
        格式非法 / 未知 theme|quality → ValueError（调用方映射 422，不静默给空列表）。"""
        statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
        async with session_factory() as session:
            order = Item.seq.desc().nulls_last()
            stmt = select(Item).order_by(order).limit(limit)
            conditions = operational_filters(
                include_archived=include_archived, include_invalid=include_invalid
            )
            if statuses:
                conditions.append(Item.status.in_(statuses))
            if source:
                conditions.append(Item.source == source)
            if focus_date is not None:
                conditions.append(Item.focus_date == date.fromisoformat(focus_date))
            if published_from is not None or published_to is not None:
                conditions.append(Item.published_at.isnot(None))
                if published_from is not None:
                    conditions.append(Item.published_at >= utc_instant(published_from))
                if published_to is not None:
                    conditions.append(Item.published_at < utc_instant(published_to))
            # 轴条件走 axis_filters（与 items_facets 同一份）；即便其余条件为空也要
            # 先求值一次——未知 theme/material 必须在这里就抛，而不是等结果集。
            conditions.extend(
                axis_filters(theme=theme, quality=quality, has_text=has_text, material=material)
            )
            if conditions:
                stmt = select(Item).where(*conditions).order_by(order).limit(limit)
            result = await session.execute(stmt)
            items = result.scalars().all()
            serialized = [self._serialize(i) for i in items]
            similar = await self._similar_map(items, session)
            for entry in serialized:
                if entry["id"] in similar:
                    entry["similar"] = similar[entry["id"]]
            return serialized

    async def items_facets(
        self, status: str | None = None, source: str | None = None,
        include_archived: bool = False, include_invalid: bool = False,
        theme: str | None = None, quality: str | None = None, has_text: bool | None = None,
        material: str | None = None,
    ) -> dict:
        """分面计数（v0.34 A）：给界面报「命中 X / 共 Y」和各轴的水位。

        **total 与 hit 必须是两个数**：total 是不加任何筛选轴的分母，hit 是加满
        当前轴之后的结果。把筛后当全量是这个仓库被坑过的形状（用户以为数据变少了）。
        `by_quality` 保持 theme/has_text/material 生效、逐档换阈值；`with_text`/`without_text`
        保持 theme/quality 生效、逐档换正文条件——两档并起来就是其余轴选定后的池子，
        所以「无正文」能被数出来，而不是被筛选悄悄滤掉。
        `unfilled` 同样保持 theme/has_text 生效，数的是「分数没采到」那一档。
        注意：**三档 + 缺值档 ≠ 全量**（实测 loose 1255 + unfilled 458 = 1713，
        分母 2659）——剩下的里有 312 条只有 ratio 没有 score，两不沾。界面不许把
        这几格说成互补划分，理由见 `quality.QUALITY_UNFILLED` 注释。
        `material`（素材类型）与上面几格不同：它是互斥划分，不另开分面——三档并起来
        恒等于分母，界面要的「图文/视频/文字帖各多少」用列表数就够，不占分面格。

        条件全部走 `axis_filters()` + `operational_filters()`：这里不许出现第二套 WHERE。
        """

        statuses = [s.strip() for s in (status or "").split(",") if s.strip()] or None
        base = operational_filters(
            include_archived=include_archived, include_invalid=include_invalid
        )
        if statuses:
            base.append(Item.status.in_(statuses))
        if source:
            base.append(Item.source == source)

        async with session_factory() as session:

            async def _count(extra: list) -> int:
                stmt = (
                    select(func.count())
                    .select_from(Item)
                    .where(*base, *extra)
                )
                return int((await session.execute(stmt)).scalar_one())

            # material 与 theme 一样是「选定后固定」的那类轴：每一格分面都在它选定的
            # 池子里数（by_quality/with_text/unfilled 都带着它），否则用户在「图文」
            # 档看到的质量分布会是全库分布——数字说的不是他正在看的那批数据。
            def _axes(**over: object) -> list:
                base_axes: dict[str, object] = {
                    "theme": theme, "quality": quality,
                    "has_text": has_text, "material": material,
                }
                base_axes.update(over)
                return axis_filters(**base_axes)  # type: ignore[arg-type]

            hit = await _count(_axes())
            by_quality = {
                tier: await _count(_axes(quality=tier)) for tier in QUALITY_TIERS
            }
            with_text = await _count(_axes(has_text=True))
            without_text = await _count(_axes(has_text=False))
            # 缺值单列（v0.34 A）：不报这一格，「标准档 252」就会被读成
            # 「其余都是低质量」，而那 17.2% 其实是采集没拿到分数（无从判断）。
            unfilled = await _count(_axes(quality=QUALITY_UNFILLED))
            return {
                "total": await _count([]),
                "hit": hit,
                "by_quality": by_quality,
                "with_text": with_text,
                "without_text": without_text,
                "unfilled": unfilled,
            }



    async def _similar_map(self, items: list[Item], session) -> dict[str, dict]:
        """审核相似提示（v0.5 A）：对 QUEUED 条目批量 phash 比对。

        参考集 = 队列内 + 已发布 + 已拒绝 的 phash（一次查询），汉明距离 ≤5；
        排除同 source_id（同源同帖由采集去重处理，不算相似重复）。
        返回 {item_id: {"published": [标题], "queued": [标题]}}（各最多 3 个）。
        """
        from backend.pipeline.dedupe import PHASH_MAX_DISTANCE, hamming_distance

        queued = [
            i for i in items
            if i.status == ItemStatus.QUEUED and i.phash and len(i.phash) >= 16
        ]
        if not queued:
            return {}
        ref_statuses = (
            ItemStatus.QUEUED, ItemStatus.APPROVED,
            ItemStatus.PUBLISHED, ItemStatus.REJECTED,
        )
        refs = (
            await session.execute(
                select(Item.id, Item.phash, Item.source_id, Item.title, Item.status)
                .where(
                    Item.phash.isnot(None),
                    Item.phash != "",
                    Item.status.in_(ref_statuses),
                )
            )
        ).all()
        out: dict[str, dict] = {}
        for item in queued:
            published: list[str] = []
            queued_titles: list[str] = []
            for rid, rphash, rsource, rtitle, rstatus in refs:
                if rid == item.id:
                    continue
                if rsource and item.source_id and rsource == item.source_id:
                    continue  # 同源同帖：采集去重已覆盖
                if not rphash or len(rphash) < 16:
                    continue
                if hamming_distance(item.phash, rphash) <= PHASH_MAX_DISTANCE:
                    bucket = published if rstatus == ItemStatus.PUBLISHED else queued_titles
                    if len(bucket) < 3:
                        bucket.append(rtitle or "")
            if published or queued_titles:
                out[str(item.id)] = {
                    "published": published,
                    "queued": queued_titles,
                }
        return out

    async def counts(self) -> dict[str, int]:
        from sqlalchemy import func

        async with session_factory() as session:
            rows = await session.execute(
                select(Item.status, func.count())
                .where(*operational_filters(include_archived=False, include_invalid=False))
                .group_by(Item.status)
            )
            return {str(status): count for status, count in rows.all()}

    async def invalid_items(self, limit: int = 200) -> list[dict]:
        """异常区「空壳/无效媒体」池（v0.33）：is_invalid 条目，seq desc 有界。

        `archive()` 有终态白名单（approved/published/rejected/failed），停在
        discovered 的空壳**归档不进去**，所以必须有这个独立入口承接——否则它们
        既不在流水线也不在异常区，等于静默消失。
        """
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item)
                    .where(Item.is_invalid.is_(True))
                    .order_by(Item.seq.desc().nulls_last())
                    .limit(limit)
                )
            ).scalars().all()
            return [self._serialize(i) for i in rows]

    async def collect_status(self) -> dict:
        """采集运维状态（v0.8.2）：运行中/上次结果/下次自动/间隔（监视 + 操作依据）。"""
        from backend.models.system import JobRun

        async with session_factory() as session:
            last_run = (
                await session.execute(
                    select(JobRun)
                    .where(JobRun.job_name == "collect")
                    .order_by(JobRun.started_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()

        interval_min = int(
            getattr(self.engine.settings, "pipeline_auto_collect_minutes", 30) or 0
        )
        # 下次自动采集 = 上次成功采集 + 间隔（registry tick 节流同语义）
        next_in_s = None
        if interval_min > 0 and last_run is not None and last_run.started_at is not None:
            from datetime import UTC, datetime

            elapsed = (datetime.now(UTC) - last_run.started_at).total_seconds()
            next_in_s = max(0, int(interval_min * 60 - elapsed))
        return {
            "running": self.running,
            "job": self.current_job(),
            "interval_min": interval_min,
            "auto_enabled": interval_min > 0,
            "next_in_s": next_in_s,
            "last": {
                "status": last_run.status if last_run else None,
                "started_at": (
                    last_run.started_at.isoformat() if last_run and last_run.started_at else None
                ),
                "summary": (last_run.summary if last_run else None) or {},
                "error": last_run.error if last_run else None,
            },
        }

    async def trends(self, days: int = 30) -> list[dict]:
        """看板趋势（v0.5 B）：按天聚合 采集/入库（job_runs.summary）+ 发布（published_at）。

        summary 为 JSONB：collect 任务含 collected/inserted；跨天任务记在 started_at 当天。
        v0.12 修正：日分组用**本地日**（与排期/日历同一时钟语义，AXIOM 单一真相源）
        ——UTC 日会把本地 0-8 点的数据错记到前一天。
        """

        local_tz = datetime.now().astimezone().tzinfo

        def _local_day(ts: datetime) -> str:
            return ts.astimezone(local_tz).strftime("%Y-%m-%d")

        now_local = datetime.now(local_tz)
        start_local = (now_local - timedelta(days=days - 1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        start = start_local.astimezone(UTC)

        async with session_factory() as session:
            # 采集/入库趋势：job_runs 中 collect 成功任务的 summary
            runs = (
                await session.execute(
                    select(JobRun)
                    .where(
                        JobRun.job_name == "collect",
                        JobRun.started_at >= start,
                    )
                )
            ).scalars().all()
            collect_by_day: dict[str, dict[str, int]] = {}
            for run in runs:
                summary = run.summary or {}
                day = _local_day(run.started_at)
                bucket = collect_by_day.setdefault(day, {"collected": 0, "inserted": 0})
                bucket["collected"] += int(summary.get("collected") or 0)
                bucket["inserted"] += int(summary.get("inserted") or 0)

            # 发布趋势：published_at 按天计数
            published_rows = (
                await session.execute(
                    select(Item.published_at)
                    .where(
                        Item.status == ItemStatus.PUBLISHED,
                        Item.published_at.isnot(None),
                        Item.published_at >= start,
                    )
                )
            ).scalars().all()
            published_by_day: dict[str, int] = {}
            for ts in published_rows:
                day = _local_day(ts)
                published_by_day[day] = published_by_day.get(day, 0) + 1

        out: list[dict] = []
        for offset in range(days):
            day = (start_local + timedelta(days=offset)).strftime("%Y-%m-%d")
            cb = collect_by_day.get(day, {})
            out.append({
                "date": day,
                "collected": cb.get("collected", 0),
                "inserted": cb.get("inserted", 0),
                "published": published_by_day.get(day, 0),
            })
        return out

    async def recent_jobs(
        self,
        limit: int = 20,
        offset: int = 0,
        job_name: str = "",
        status: str = "",
    ) -> dict:
        """任务历史（v0.8.7 企业级对齐）：DB job_runs 全量历史——分页 + 类型/状态筛选。

        v0.8.8 查漏补缺：列表返回轻量摘要（§2.3 接口存在理由 / §7.2 交互预算）——
        逐源明细等大字段仅在展开详情时经 /jobs/{id} 懒加载。
        """
        async with session_factory() as session:
            stmt = select(JobRun)
            if job_name:
                stmt = stmt.where(JobRun.job_name == job_name)
            if status:
                stmt = stmt.where(JobRun.status == status)
            total = (
                await session.execute(
                    select(func.count()).select_from(stmt.subquery())
                )
            ).scalar_one()
            rows = (
                await session.execute(
                    stmt.order_by(JobRun.started_at.desc())
                    .offset(max(offset, 0))
                    .limit(max(1, min(limit, 200)))
                )
            ).scalars().all()
            return {
                "total": total,
                "jobs": [self._job_dict(j, light=True) for j in rows],
            }

    async def job_detail(self, job_id: uuid.UUID) -> dict:
        """单任务详情（v0.8.7）：完整 summary（逐源明细/delta）+ 耗时 + 错误。"""
        from backend.errors import HertzError

        async with session_factory() as session:
            job = await session.get(JobRun, job_id)
            if job is None:
                raise HertzError("not_found", "job not found")
            return self._job_dict(job)

    async def collect_history(self, limit: int = 10) -> list[dict]:
        """采集历史轮次（v0.8.7）：最近 N 轮 collect 任务——逐源明细时间线。

        采集卡/活动面板共用：每轮含 sources 数组（channel/collected/inserted/
        skipped/cooldown_s/error/empty）——「采集最近历史」的单一真相源。
        """
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(JobRun)
                    .where(JobRun.job_name == "collect")
                    .order_by(JobRun.started_at.desc())
                    .limit(max(1, min(limit, 50)))
                )
            ).scalars().all()
            return [self._job_dict(j) for j in rows]

    @staticmethod
    def _job_dict(j: JobRun, *, light: bool = False) -> dict:
        started = j.started_at
        finished = j.finished_at
        duration_s = None
        if started is not None and finished is not None:
            duration_s = round((finished - started).total_seconds(), 1)
        summary = j.summary or {}
        base = {
            "id": str(j.id),
            "job": j.job_name,
            "status": j.status,
            "error": j.error,
            "started_at": started.isoformat() if started else None,
            "finished_at": finished.isoformat() if finished else None,
            "duration_s": duration_s,
        }
        if light:
            # 轻量摘要：列表行渲染所需计数（不含逐源明细/delta——展开时懒加载）
            sources = summary.get("sources") or []
            sources_ok = sum(
                1
                for s in sources
                if isinstance(s, dict) and not s.get("error") and not s.get("empty")
            )
            sources_err = sum(
                1
                for s in sources
                if isinstance(s, dict) and s.get("error")
            )
            base["summary"] = {
                "collected": summary.get("collected"),
                "inserted": summary.get("inserted"),
                "skipped": summary.get("skipped"),
                "processed": summary.get("processed"),
                "ok": summary.get("ok"),
                "failed": summary.get("failed"),
                "sources_ok": sources_ok,
                "sources_err": sources_err,
                "empty": summary.get("empty"),
            }
        else:
            base["summary"] = summary
        return base

    async def sources(self) -> list[dict]:
        """采集源健康度（v0.2.1，参考原项目三态）：dead / degraded / healthy。"""
        async with session_factory() as session:
            result = await session.execute(
                select(SourceState).order_by(SourceState.channel)
            )
            rows = result.scalars().all()
            out = []
            for s in rows:
                total = s.ok_count + s.fail_count
                if s.ok_count == 0 and s.fail_count > 0:
                    health = "dead"
                elif s.consecutive_fails >= 3 or (total > 0 and s.fail_count / total > 0.6):
                    health = "degraded"
                else:
                    health = "healthy"
                out.append({
                    "source": s.source,
                    "channel": s.channel,
                    "cursor": s.get_cursor(),
                    "ok_count": s.ok_count,
                    "fail_count": s.fail_count,
                    "consecutive_fails": s.consecutive_fails,
                    "last_error": s.last_error,
                    "last_error_at": s.last_error_at.isoformat() if s.last_error_at else None,
                    "last_run_at": s.last_run_at.isoformat() if s.last_run_at else None,
                    "last_strategy": s.last_strategy,  # v0.8.9 通道可观测（oauth/json/rss）
                    "health": health,
                })
            return out

    async def supply_warnings(self) -> list[str]:
        """供给告警（参考原项目漏斗水位）：空漏斗 / 供给偏紧 / 采集源失联 / 调度器静默。"""
        warnings: list[str] = []
        # 调度器静默（v0.34 D-223）：所有定时作业都经由 `_timed` → `record_tick` 落一行遥测，
        # 所以「进程活着但一条 tick 都没有」就是「作业注册了却从没执行」的直接证据——
        # 这个缺陷存在期间采集停了六周，而界面上唯一的信号是一个都没接出来的告警。
        # 宽限期只按启动时长算：刚起来的 3 分钟内 1 分钟作业可能确实还没轮到，不许误报。
        from backend.infrastructure import telemetry

        snap = telemetry.snapshot()
        if int(snap.get("uptime_s") or 0) > 180 and not snap.get("ticks"):
            warnings.append("scheduler_silent")
        async with session_factory() as session:
            total_items = (
                await session.execute(select(func.count(Item.id)))
            ).scalar_one()
            if total_items == 0:
                warnings.append("funnel_empty")
                return warnings
            pre = (
                await session.execute(
                    select(func.count(Item.id)).where(
                        Item.status.in_(
                            (ItemStatus.DISCOVERED, ItemStatus.DOWNLOADED, ItemStatus.SCORED)
                        )
                    )
                )
            ).scalar_one()
            if pre < 5:
                warnings.append("supply_tight")
            sources = (
                await session.execute(
                    select(SourceState).where(SourceState.fail_count > 0)
                )
            ).scalars().all()
            if any(s.consecutive_fails >= 3 for s in sources):
                warnings.append("source_unreachable")
        return warnings

    # ---------- 失败分类看板（v0.2.1，参考原项目 Autarkeia） ----------

    async def failure_classes(self) -> dict[str, int]:
        """failed 条目按 error_class 聚合统计（空类 = 旧数据/未分类）。"""
        async with session_factory() as session:
            result = await session.execute(
                select(Item.error_class, Item.id).where(
                    Item.status == ItemStatus.FAILED,
                    Item.archived.is_(False),
                )
            )
            counts: dict[str, int] = {}
            for cls, _ in result:
                counts[cls or "other"] = counts.get(cls or "other", 0) + 1
            return counts

    async def retry_class(self, cls: str) -> int:
        """同类批量重试：把该失败分类的所有 failed 条目复位回可继续的状态。"""
        from backend.pipeline.errors import FAILURE_CLASSES

        if cls not in FAILURE_CLASSES:
            raise ValueError(f"unknown failure class '{cls}'")
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Item).where(
                        Item.status == ItemStatus.FAILED,
                        Item.error_class == cls,
                        Item.archived.is_(False),
                    )
                )
            ).scalars().all()
            from backend.pipeline.helpers import back_status_for

            for item in rows:
                item.status = back_status_for(item)
                item.error = None
                item.error_class = ""
                item.retry_count += 1
            await session.commit()
            return len(rows)
