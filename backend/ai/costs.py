"""Cost accounting (v0.14): 计价与聚合——成本控制页的数据层。

计费口径（D-176）：**查询时按当前单价动态计算**——ai_model_prices 为唯一
真相源，改价追溯历史报表；ai_calls 只存 token 事实，不入库价格快照。

职责单一：本模块只做「算钱 + 聚合」，不改 AI 调用写入链路（tracing），
不做路由；环节归因依赖 ai_calls.caller/operation 的语义化取值。
"""

import asyncio
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from backend.infrastructure.timeutils import local_day_str
from backend.models.ai_registry import AICall
from backend.models.session import session_factory

# 预算阶梯告警去重状态："年月:level"——升级沿才推送（v0.22 A2）
_last_budget_alert: str | None = None

# 轻量预算状态缓存（v0.25 Router 阶梯降级）：30s TTL 避免每条评分打 DB
_BUDGET_CACHE: dict | None = None
_BUDGET_CACHE_AT: float = 0.0
_BUDGET_CACHE_TTL = 30.0


def _budget_level_from_ratio(ratio: float) -> str:
    """ratio → level（与 aggregate_costs 保持一致）。"""
    if ratio >= 0.95:
        return "exceeded"
    if ratio >= 0.8:
        return "critical"
    if ratio >= 0.5:
        return "warning"
    return "ok"


async def get_budget_state(*, now: datetime | None = None, use_cache: bool = True) -> dict | None:
    """月度预算阶梯状态（轻量版，供 Router 快速决策）。

    Returns: {monthly, used, ratio, level, month_start} | None（budget=0 时 None）。
    缓存 30s，避免评分批处理时每条打 DB。
    """
    global _BUDGET_CACHE, _BUDGET_CACHE_AT
    import time as _time

    if use_cache and _BUDGET_CACHE is not None:
        if _time.monotonic() - _BUDGET_CACHE_AT < _BUDGET_CACHE_TTL:
            return _BUDGET_CACHE

    from backend.config import settings as app_settings

    budget = float(getattr(app_settings, "cost_monthly_budget", 0.0) or 0.0)
    if budget <= 0:
        return None
    prices = dict(getattr(app_settings, "ai_model_prices", {}) or {})
    rate = float(getattr(app_settings, "cost_usd_rate", 7.2) or 7.2)
    currency = str(getattr(app_settings, "cost_currency", "CNY") or "CNY")
    # CNY 场景 rate 已为 USD→CNY，直接用；USD 场景 rate=1
    if currency.upper() == "USD":
        rate = 1.0
    now = now or datetime.now(UTC)
    month_start = now.astimezone().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    m_start_utc = month_start.astimezone(UTC)
    async with session_factory() as session:
        month_rows = (
            await session.execute(select(AICall).where(AICall.created_at >= m_start_utc))
        ).scalars().all()
    month_cost = 0.0
    for r in month_rows:
        c = estimate_cost(r.model_key, r.prompt_tokens, r.completion_tokens, prices)
        if c is not None:
            month_cost += c
    used = round(month_cost * rate, 6)
    ratio = used / budget if budget else 0.0
    level = _budget_level_from_ratio(ratio)
    state = {
        "monthly": budget,
        "used": used,
        "ratio": round(min(ratio, 9.99), 4),
        "level": level,
        "month_start": local_day_str(m_start_utc),
    }
    if use_cache:
        _BUDGET_CACHE = state
        _BUDGET_CACHE_AT = _time.monotonic()
    return state


def _clear_budget_cache() -> None:
    """测试辅助：清除预算缓存。"""
    global _BUDGET_CACHE, _BUDGET_CACHE_AT
    _BUDGET_CACHE = None
    _BUDGET_CACHE_AT = 0.0

# 溯源约定（v0.14.1）：pipeline 域调用点 task_id = "item:<uuid>"
_ITEM_REF = re.compile(r"^item:([0-9a-f-]{36})$")

# 已知费用环节（operation 直用）；chat 按 caller 消歧（编排工作流 vs 对话）
_KNOWN_OPERATIONS = ("score", "script", "title", "translate", "packaging")

# 内存聚合行数硬上限（v0.20 性能防线）
_MAX_AGGREGATE_ROWS = 20_000


def estimate_cost(
    model_key: str,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    prices: dict,
) -> float | None:
    """按「美元/百万 tokens」计价；模型未配价（或价格表缺字段）→ None。"""
    price = prices.get(model_key)
    if not isinstance(price, dict):
        return None
    p, c = price.get("prompt"), price.get("completion")
    if p is None and c is None:
        return None
    cost = ((prompt_tokens or 0) / 1e6 * float(p or 0)) + (
        (completion_tokens or 0) / 1e6 * float(c or 0)
    )
    return round(cost, 6)


def _domain_of(caller: str, operation: str) -> str:
    """(caller, operation) → 费用环节 key。未知 operation 原样透传
    （新工序接入免改代码，前端未翻译时回退显示原文）。"""
    if operation in _KNOWN_OPERATIONS:
        return operation
    if caller == "orchestrator":
        return "orchestrator"
    if operation in ("chat", "stream_chat"):
        return "chat"
    return operation or "other"


async def aggregate_costs(
    *,
    days: int = 30,
    domain: str | None = None,
    limit: int = 50,
    offset: int = 0,
    now: datetime | None = None,
    prices: dict | None = None,
    currency: str = "USD",
    rate: float = 1.0,
) -> dict:
    """区间成本报表：概览 + 按环节 + 按模型 + 日趋势 + 执行历史明细。

    内存聚合（单机桌面量级：数千行内）；金额全部按当前单价动态计算，
    再按 currency/rate 换算报表币种（v0.14.1：默认 CNY，rate=USD→目标币）。
    """
    if prices is None:
        from backend.config import settings

        prices = dict(getattr(settings, "ai_model_prices", {}) or {})
    now = now or datetime.now(UTC)
    cutoff = now - timedelta(days=max(days, 1))

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(AICall)
                .where(AICall.created_at >= cutoff)
                .order_by(AICall.created_at.desc())
                # v0.20 性能防线：内存聚合行数硬上限（桌面量级数千行，
                # 极端积累时取最近 2 万行并如实标注截断）
                .limit(_MAX_AGGREGATE_ROWS)
            )
        ).scalars().all()
        truncated = len(rows) >= _MAX_AGGREGATE_ROWS

    def _row_cost(r: AICall) -> float | None:
        return estimate_cost(r.model_key, r.prompt_tokens, r.completion_tokens, prices)

    by_domain: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    daily: dict[str, float] = {}
    missing: set[str] = set()
    total_cost = 0.0
    billed_calls = 0
    prompt_total = completion_total = 0
    in_domain_rows: list[AICall] = []

    for r in rows:
        d = _domain_of(r.caller or "", r.operation or "")
        if domain is not None and d != domain:
            continue
        in_domain_rows.append(r)
        cost = _row_cost(r)
        pt = int(r.prompt_tokens or 0)
        ct = int(r.completion_tokens or 0)
        prompt_total += pt
        completion_total += ct

        for bucket, key in ((by_domain, d), (by_model, r.model_key or "unknown")):
            b = bucket.setdefault(
                key,
                {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
                 "cost": 0.0, "_unpriced": False},
            )
            b["calls"] += 1
            b["prompt_tokens"] += pt
            b["completion_tokens"] += ct
            if cost is None:
                # 金额未知 ≠ 免费：桶内混入未配价调用 → 整桶金额不可信，置 None
                b["cost"] = None
                b["_unpriced"] = True
            elif b["cost"] is not None:
                b["cost"] = round(b["cost"] + cost, 6)

        if cost is None:
            missing.add(r.model_key or "unknown")
        else:
            billed_calls += 1
            total_cost = round(total_cost + cost, 6)
            day = local_day_str(r.created_at)
            daily[day] = round(daily.get(day, 0.0) + cost, 6)

    def _sorted_views(bucket: dict, name_key: str) -> list[dict]:
        out = [{name_key: k, **{k2: v for k2, v in v2.items() if k2 != "_unpriced"}}
               for k, v2 in bucket.items()]
        # 计费金额降序；未配价（cost=None）排后但保持可见
        return sorted(out, key=lambda x: -(x["cost"] or 0))

    def _to_currency(usd: float | None) -> float | None:
        """USD → 报表币种；None（未配价）不换算。"""
        if usd is None:
            return None
        return round(usd * rate, 6)

    total = len(in_domain_rows)

    # 溯源（v0.14.1）：task_id="item:<uuid>" → 条目标题 + 产物目录绝对路径。
    # v0.15 条目 ROI：全窗口行收集 item 关联，聚合出每条视频的 AI 总成本，
    # JOIN items 取标题/发布时间/播放量（publish_stats 回捞 best-effort）。
    # 批量解析一次；条目已删除/清洗 → 关联降级为 None
    item_ids = {
        m.group(1)
        for r in in_domain_rows
        if r.task_id and (m := _ITEM_REF.fullmatch(r.task_id))
    }
    items_by_id: dict[str, dict] = {}
    if item_ids:
        from uuid import UUID

        from backend.config import settings as app_settings
        from backend.models.item import Item

        async with session_factory() as session:
            rows = (
                await session.execute(select(Item).where(Item.id.in_(
                    [UUID(x) for x in item_ids]
                )))
            ).scalars().all()
        for it in rows:
            asset_path = ""
            if it.output_dir:
                asset_path = str(
                    (Path(app_settings.data_dir) / it.output_dir).resolve()
                )
            stats = (it.publish_json or {}).get("stats") or {}
            items_by_id[str(it.id)] = {
                "title": it.title or "",
                "asset_path": asset_path,
                "published_at": (
                    it.published_at.isoformat() if it.published_at else None
                ),
                "views": stats.get("view"),
            }

    def _item_ref(r: AICall) -> dict | None:
        if not r.task_id or not (m := _ITEM_REF.fullmatch(r.task_id)):
            return None
        hit = items_by_id.get(m.group(1))
        if hit is None:
            return None  # 条目已删除/清洗——无效关联降级
        return {
            "id": m.group(1),
            "title": hit["title"],
            "asset_path": hit["asset_path"] or None,
        }

    # 条目 ROI 聚合（Helicone sessions 精华借鉴）：一条视频的 AI 总成本。
    # 孤儿关联（条目已删除）不计入 ROI 视图——成本仍计入 summary
    by_item: dict[str, dict] = {}
    for r in in_domain_rows:
        if not r.task_id or not (m := _ITEM_REF.fullmatch(r.task_id)):
            continue
        iid = m.group(1)
        if iid not in items_by_id:
            continue
        b = by_item.setdefault(iid, {"calls": 0, "cost": 0.0, "_unpriced": False})
        b["calls"] += 1
        cost = _row_cost(r)
        if cost is None:
            b["cost"] = None
            b["_unpriced"] = True
        elif b["cost"] is not None:
            b["cost"] = round(b["cost"] + cost, 6)

    items_view = [
        {
            "item_id": iid,
            "title": (items_by_id.get(iid) or {}).get("title", ""),
            "published_at": (items_by_id.get(iid) or {}).get("published_at"),
            "views": (items_by_id.get(iid) or {}).get("views"),
            "calls": b["calls"],
            "ai_cost": _to_currency(b["cost"]),
            "asset_path": (items_by_id.get(iid) or {}).get("asset_path") or None,
        }
        for iid, b in by_item.items()
    ]
    items_view.sort(key=lambda x: -(x["ai_cost"] or 0))

    calls_view = [
        {
            "id": str(r.id),
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "domain": _domain_of(r.caller or "", r.operation or ""),
            "caller": r.caller,
            "provider_key": r.provider_key,
            "model_key": r.model_key,
            "operation": r.operation,
            "prompt_tokens": r.prompt_tokens,
            "completion_tokens": r.completion_tokens,
            "duration_ms": r.duration_ms,
            "status": r.status,
            "error": (r.error or "")[:200],
            "cost": _row_cost(r),
            "task_id": r.task_id,
            "item": _item_ref(r),
        }
        for r in in_domain_rows[offset : offset + limit]
    ]

    symbol = {"CNY": "¥", "USD": "$"}.get(currency.upper(), currency.upper() + " ")
    report = {
        "currency": {"code": currency.upper(), "symbol": symbol, "rate": rate},
        "summary": {
            "total_calls": total,
            "billed_calls": billed_calls,
            "total_cost": _to_currency(total_cost),
            "coverage": round(billed_calls / total, 4) if total else 1.0,
            "prompt_tokens": prompt_total,
            "completion_tokens": completion_total,
            "days": days,
            # v0.20：达到聚合行数上限时如实标注（数据被截断到最近 2 万行）
            "truncated": truncated,
        },
        "by_domain": [
            {**v, "cost": _to_currency(v["cost"])}
            for v in _sorted_views(by_domain, "domain")
        ],
        "by_model": [
            {**v, "cost": _to_currency(v["cost"])}
            for v in _sorted_views(by_model, "model_key")
        ],
        "daily": [
            {"date": d, "cost": _to_currency(c)}
            for d, c in sorted(daily.items())
        ],
        "missing_prices": sorted(missing),
        "calls": calls_view,
        # 条目 ROI（v0.15）：每条视频的 AI 总成本 × 播放表现
        "items": items_view,
    }

    # 月度预算阶梯（v0.17，Helicone 精华借鉴）：自然月累计 vs 预算，
    # 三档提示（50%/80%/95%）——只警示不阻断。budget=0 → budget=None
    from backend.config import settings as app_settings

    budget = float(getattr(app_settings, "cost_monthly_budget", 0.0) or 0.0)
    if budget > 0:

        month_start = now.astimezone().replace(
            day=1, hour=0, minute=0, second=0, microsecond=0
        )
        m_start_utc = month_start.astimezone(UTC)
        async with session_factory() as session:
            month_rows = (
                await session.execute(
                    select(AICall).where(AICall.created_at >= m_start_utc)
                )
            ).scalars().all()
        month_cost = 0.0
        for r in month_rows:
            c = estimate_cost(r.model_key, r.prompt_tokens, r.completion_tokens, prices)
            if c is not None:
                month_cost += c
        used = round(month_cost * rate, 6)
        ratio = used / budget
        level = _budget_level_from_ratio(ratio)
        # 告警（v0.22 A2 接线）：阶梯升级沿推送一次（降级/跨月重置后可再报）。
        # 模块级状态——进程生命周期内去重；report 本身仍按需计算。
        global _last_budget_alert
        if level in ("warning", "critical", "exceeded"):
            stamp = f"{now.strftime('%Y%m')}:{level}"
            if _last_budget_alert != stamp:
                _last_budget_alert = stamp

                async def _push() -> None:
                    from backend.integrations.telegram_bot import push_alert

                    await push_alert(
                        f"🟠 AI 成本预算 [{level}]：本月已用 {used:.2f}"
                        f"/{budget:.2f}（{ratio * 100:.0f}%）"
                    )

                asyncio.ensure_future(_push())
        report["budget"] = {
            "monthly": budget,
            "used": used,
            "ratio": round(min(ratio, 9.99), 4),
            "level": level,
            "month_start": local_day_str(m_start_utc),
        }
    else:
        report["budget"] = None

    return report
