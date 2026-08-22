"""Cost accounting (v0.14): 计价与聚合——成本控制页的数据层。

计费口径（D-176）：**查询时按当前单价动态计算**——ai_model_prices 为唯一
真相源，改价追溯历史报表；ai_calls 只存 token 事实，不入库价格快照。

职责单一：本模块只做「算钱 + 聚合」，不改 AI 调用写入链路（tracing），
不做路由；环节归因依赖 ai_calls.caller/operation 的语义化取值。
"""

import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from backend.infrastructure.timeutils import local_day_str
from backend.models.ai_registry import AICall
from backend.models.session import session_factory

# 溯源约定（v0.14.1）：pipeline 域调用点 task_id = "item:<uuid>"
_ITEM_REF = re.compile(r"^item:([0-9a-f-]{36})$")

# 已知费用环节（operation 直用）；chat 按 caller 消歧（编排工作流 vs 对话）
_KNOWN_OPERATIONS = ("score", "script", "title", "translate", "packaging")


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
                select(AICall).where(AICall.created_at >= cutoff).order_by(
                    AICall.created_at.desc()
                )
            )
        ).scalars().all()

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
    # 批量解析一次（明细页 ≤ limit 行）；条目已删除/清洗 → 关联降级为 None
    item_ids = {
        m.group(1)
        for r in in_domain_rows[offset : offset + limit]
        if r.task_id and (m := _ITEM_REF.fullmatch(r.task_id))
    }
    items_by_id: dict[str, tuple[str, str]] = {}
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
            items_by_id[str(it.id)] = (it.title or "", asset_path)

    def _item_ref(r: AICall) -> dict | None:
        if not r.task_id or not (m := _ITEM_REF.fullmatch(r.task_id)):
            return None
        hit = items_by_id.get(m.group(1))
        if hit is None:
            return None  # 条目已删除/清洗——无效关联降级
        title, asset_path = hit
        return {
            "id": m.group(1),
            "title": title,
            "asset_path": asset_path or None,
        }

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
    return {
        "currency": {"code": currency.upper(), "symbol": symbol, "rate": rate},
        "summary": {
            "total_calls": total,
            "billed_calls": billed_calls,
            "total_cost": _to_currency(total_cost),
            "coverage": round(billed_calls / total, 4) if total else 1.0,
            "prompt_tokens": prompt_total,
            "completion_tokens": completion_total,
            "days": days,
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
    }
