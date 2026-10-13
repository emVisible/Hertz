"""成本控制（v0.14）契约测试：计价纯函数 + 环节归因 + 聚合端点。

计费口径（D-176）：查询时按当前单价动态计算——ai_model_prices 为唯一真相源，
改单价追溯历史报表；入库快照不使用。
"""

from datetime import UTC, datetime, timedelta

import pytest

from backend.ai.costs import _domain_of, aggregate_costs, estimate_cost
from backend.models.ai_registry import AICall
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory

PRICES = {"deepseek-chat": {"prompt": 0.27, "completion": 1.1}}

NOW = datetime.now(UTC)

import uuid as _uuid  # noqa: E402

# ---------- estimate_cost ----------


def test_estimate_cost_basic() -> None:
    """百万单价 × token：1M in + 1M out = 0.27 + 1.10。"""
    cost = estimate_cost("deepseek-chat", 1_000_000, 1_000_000, PRICES)
    assert cost == pytest.approx(1.37)


def test_estimate_cost_missing_price_returns_none() -> None:
    """未配价模型 → None（前端显示「未配价」并列缺价清单）。"""
    assert estimate_cost("unknown-model", 1000, 1000, PRICES) is None


def test_estimate_cost_partial_price() -> None:
    """只配了 completion 单价：prompt 按 0 计。"""
    cost = estimate_cost("m", 1_000_000, 2_000_000, {"m": {"completion": 1.0}})
    assert cost == pytest.approx(2.0)


def test_estimate_cost_zero_tokens() -> None:
    assert estimate_cost("deepseek-chat", 0, 0, PRICES) == 0.0


# ---------- 环节归因 ----------


def test_domain_of_operation_first() -> None:
    """operation 自带语义的直接作环节：评分/脚本/标题包装/翻译。"""
    assert _domain_of("ai", "score") == "score"
    assert _domain_of("ai", "script") == "script"
    assert _domain_of("ai", "title") == "title"
    assert _domain_of("pipeline", "translate") == "translate"


def test_domain_of_chat_disambiguated_by_caller() -> None:
    """chat 按 caller 消歧：编排工作流 vs 对话。"""
    assert _domain_of("orchestrator", "chat") == "orchestrator"
    assert _domain_of("ai", "chat") == "chat"


def test_domain_of_unknown_operation_passthrough() -> None:
    """未知 operation 原样作环节（未来工序扩展免改代码）。"""
    assert _domain_of("ai", "image_gen") == "image_gen"


# ---------- aggregate_costs ----------


_CREATED_CALLS: list = []


async def _mk_call(**kw) -> None:
    defaults = dict(
        task_id=None, caller="ai", provider_key="deepseek",
        model_key="deepseek-chat", role="fast", operation="score",
        duration_ms=800, prompt_tokens=100_000, completion_tokens=10_000,
        status="ok", created_at=datetime.now(UTC),
    )
    defaults.update(kw)
    async with session_factory() as session:
        row = AICall(**defaults)
        session.add(row)
        await session.commit()
        _CREATED_CALLS.append(row.id)


@pytest.fixture(autouse=True)
async def _clean_ai_calls():
    """本文件插入的 ai_calls 测试后清除——conftest 无 per-test 清表，
    残留行会被后续聚合测试的 days 窗口误数。"""
    yield
    from sqlalchemy import delete

    if not _CREATED_CALLS:
        return
    async with session_factory() as session:
        await session.execute(
            delete(AICall).where(AICall.id.in_(_CREATED_CALLS))
        )
        await session.commit()
        _CREATED_CALLS.clear()


@pytest.mark.asyncio
async def test_aggregate_groups_summary_and_domains(client) -> None:
    await _mk_call(operation="score", prompt_tokens=1_000_000, completion_tokens=100_000)
    await _mk_call(operation="score", prompt_tokens=500_000, completion_tokens=50_000)
    await _mk_call(operation="script", prompt_tokens=200_000, completion_tokens=20_000)
    await _mk_call(caller="orchestrator", operation="chat", model_key="unpriced-m")

    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    s = report["summary"]
    assert s["total_calls"] == 4
    # deepseek-chat 三条计费：(1.5M*0.27 + 150k*1.1) + (0.2M*0.27 + 20k*1.1)
    assert s["total_cost"] == pytest.approx((1.5 * 0.27 + 0.15 * 1.1) + (0.2 * 0.27 + 0.02 * 1.1))
    assert s["coverage"] == pytest.approx(3 / 4)

    domains = {d["domain"]: d for d in report["by_domain"]}
    assert domains["score"]["calls"] == 2
    assert domains["score"]["cost"] == pytest.approx(1.5 * 0.27 + 0.15 * 1.1)
    assert domains["script"]["calls"] == 1
    assert domains["orchestrator"]["cost"] is None  # 未配价模型

    assert "unpriced-m" in report["missing_prices"]
    models = {m["model_key"]: m for m in report["by_model"]}
    assert models["deepseek-chat"]["calls"] == 3
    assert len(report["daily"]) >= 1
    assert len(report["calls"]) == 4


@pytest.mark.asyncio
async def test_aggregate_respects_days_window(client) -> None:
    await _mk_call(created_at=datetime.now(UTC) - timedelta(days=40))
    await _mk_call()
    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert report["summary"]["total_calls"] == 1


@pytest.mark.asyncio
async def test_aggregate_domain_filter(client) -> None:
    """domain 参数：服务端筛选——summary/by_domain/calls 均只含目标环节。"""
    await _mk_call(operation="score")
    await _mk_call(operation="script")
    report = await aggregate_costs(days=30, domain="score", prices=PRICES, now=NOW)
    assert report["summary"]["total_calls"] == 1
    assert [d["domain"] for d in report["by_domain"]] == ["score"]
    assert all(c["domain"] == "score" for c in report["calls"])


@pytest.mark.asyncio
async def test_aggregate_pagination(client) -> None:
    """limit/offset 明细分页：hasMore 由调用方以 total_calls 判断。"""
    for _i in range(3):
        await _mk_call(operation="chat")
    page1 = await aggregate_costs(days=30, limit=2, offset=0, prices=PRICES, now=NOW)
    assert len(page1["calls"]) == 2
    page2 = await aggregate_costs(days=30, limit=2, offset=2, prices=PRICES, now=NOW)
    assert len(page2["calls"]) == 1
    # 两页 id 不重叠
    p1_ids = {c["id"] for c in page1["calls"]}
    p2_ids = {c["id"] for c in page2["calls"]}
    assert not (p1_ids & p2_ids)


@pytest.mark.asyncio
async def test_costs_endpoint_shape(client) -> None:
    await _mk_call(operation="score")
    resp = await client.get("/api/ai/costs?days=30")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("summary", "by_domain", "by_model", "daily", "missing_prices",
                "calls", "items"):
        assert key in body


# ---------- 条目 ROI（v0.15，Helicone 单位经济借鉴） ----------


@pytest.mark.asyncio
async def test_by_item_aggregates_cost_with_views(client) -> None:
    """同一条目的多次调用聚合为 ai_cost；JOIN 出播放量；跨条目独立。"""
    import uuid as _uuid

    from backend.models.item import Item

    async with session_factory() as session:
        row = Item(
            status="published", source="reddit", source_id="roi-1",
            title="ROI 条目", output_dir="pipeline/roi-01",
            published_at=NOW - timedelta(days=1),
            publish_json={"stats": {"view": 12000}},
        )
        session.add(row)
        await session.commit()
        item_id = str(row.id)

    # 同条目两次调用（1M prompt → $0.27）+ 另一条目一次 + 无关联一次
    await _mk_call(operation="script", task_id=f"item:{item_id}",
                   prompt_tokens=500_000, completion_tokens=50_000)
    await _mk_call(operation="score", task_id=f"item:{item_id}",
                   prompt_tokens=500_000)
    other_id = str(_uuid.uuid4())
    await _mk_call(operation="script", task_id=f"item:{other_id}",
                   prompt_tokens=1_000_000)

    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    items = {x["item_id"]: x for x in report["items"]}
    roi = items[item_id]
    assert roi["calls"] == 2
    # call1: 500k in + 50k out；call2: 500k in + 10k out(_mk_call 默认)
    assert roi["ai_cost"] == pytest.approx(
        (0.5 * 0.27 + 0.05 * 1.1) + (0.5 * 0.27 + 0.01 * 1.1)
    )
    assert roi["views"] == 12000
    assert roi["title"] == "ROI 条目"
    # 关联条目已删（other_id 不在 items 表）→ ROI 视图不出现
    assert other_id not in items


# ---------- 溯源（v0.14.1）：task_id="item:<uuid>" → 条目/产物路径 ----------


@pytest.mark.asyncio
async def test_call_with_item_ref_resolves_asset_path(client) -> None:
    """task_id=item:<uuid> → 明细行带 item 关联（标题 + 产物目录绝对路径）。"""

    from backend.models.item import Item

    async with session_factory() as session:
        row = Item(
            status="queued", source="reddit", source_id="cost-trace",
            title="溯源测试条目", output_dir="pipeline/trace-01",
        )
        session.add(row)
        await session.commit()
        item_id = str(row.id)

    await _mk_call(operation="script", task_id=f"item:{item_id}")

    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    call = next(c for c in report["calls"] if c["task_id"] == f"item:{item_id}")
    assert call["item"] is not None
    assert call["item"]["title"] == "溯源测试条目"
    assert call["item"]["asset_path"].endswith("pipeline/trace-01")
    # 无关联的调用 → item=None（本文件其余调用均无 task_id）
    assert all(c["item"] is None for c in report["calls"] if c["task_id"] != f"item:{item_id}")


@pytest.mark.asyncio
async def test_call_without_item_ref_has_no_item(client) -> None:
    await _mk_call(operation="score")
    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert all(c["item"] is None for c in report["calls"])


@pytest.mark.asyncio
async def test_item_ref_to_missing_item_degrades(client) -> None:
    """条目已被删除/归档清洗 → item=None，不抛错。"""
    await _mk_call(operation="script", task_id=f"item:{_uuid.uuid4()}")
    report = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert all(c["item"] is None for c in report["calls"])


# ---------- 币种换算（v0.14.1） ----------


@pytest.mark.asyncio
async def test_aggregate_converts_currency(client) -> None:
    """currency=CNY + rate：金额按汇率换算并回传币种元信息。"""
    await _mk_call(prompt_tokens=1_000_000, completion_tokens=0)
    usd = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    cny = await aggregate_costs(
        days=30, prices=PRICES, now=NOW, currency="CNY", rate=7.2,
    )
    assert usd["summary"]["total_cost"] == pytest.approx(0.27)
    assert cny["summary"]["total_cost"] == pytest.approx(0.27 * 7.2)
    assert cny["currency"]["code"] == "CNY"
    assert cny["currency"]["symbol"] == "¥"
    assert usd["currency"]["code"] == "USD"


# ---------- 月度预算阶梯（v0.17） ----------


@pytest.mark.asyncio
async def test_budget_levels(client, monkeypatch) -> None:
    """三档阶梯：50%→warning / 80%→critical / 95%+→exceeded；0 预算 → None。"""
    from backend.config import settings

    await _mk_call(prompt_tokens=1_000_000)  # $0.27 @ PRICES

    monkeypatch.setattr(settings, "cost_monthly_budget", 0.5)
    r = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert r["budget"]["level"] == "warning"  # 54%
    assert r["budget"]["monthly"] == 0.5

    monkeypatch.setattr(settings, "cost_monthly_budget", 0.32)
    r = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert r["budget"]["level"] == "critical"  # ~84%

    monkeypatch.setattr(settings, "cost_monthly_budget", 0.28)
    r = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert r["budget"]["level"] == "exceeded"  # ~96%

    monkeypatch.setattr(settings, "cost_monthly_budget", 0.0)
    r = await aggregate_costs(days=30, prices=PRICES, now=NOW)
    assert r["budget"] is None


# ---------- 频道洞察（v0.19 数据飞轮一期） ----------


@pytest.mark.asyncio
async def test_insights_generate_and_inject(client, monkeypatch) -> None:
    """样本充足 → LLM 分析落库；latest() 返回最新；score prompt 注入洞察。"""

    from backend.models.item import Item
    from backend.models.session import session_factory

    # 5 条已发布（满足 MIN_SAMPLE）
    async with session_factory() as session:
        for i in range(5):
            session.add(Item(
                status="published", source="reddit", source_id=f"ins-{i}",
                title=f"视频{i}", subreddit="aww", author="u",
                score_total=7.0,
                published_at=NOW - timedelta(days=i + 1),
                publish_json={"stats": {"view": 5000 if i < 2 else 50}},
            ))
        await session.commit()

    class FakeInsightAI:
        async def chat_messages(self, messages, **kw):
            return ('{"audience_preferences": ["动物高能瞬间"], '
                    '"hook_styles": ["开门见山"], "avoid_topics": [], "notes": "多发动物"}')

    from backend.factory.registry import ServiceRegistry

    registry = ServiceRegistry.get()
    old_ai = registry.ai
    registry.ai = FakeInsightAI()
    try:
        resp = await client.post("/api/ai/insights/generate")
        assert resp.status_code == 200
        body = resp.json()
        assert "动物" in body["notes"]
        assert body["source_count"] >= 5  # 窗口内可能含其他测试的 published 残留
    finally:
        registry.ai = old_ai

    # 注入：走真 TaskRouter.score（llm=fake 捕获 system messages 含洞察）
    seen: list[list] = []

    class StreamFake:
        async def chat_stream(self, messages, **kw):
            seen.append([getattr(m, "content", str(m)) for m in messages])
            yield '{"total": 7.0, "dimensions": {}, "reasons": []}'

    from backend.ai.router import TaskRouter

    old_engine_ai = registry.pipeline.engine.ai
    registry.pipeline.engine.ai = TaskRouter(llm=StreamFake())
    try:

        async with session_factory() as session:
            row = Item(status="discovered", source="reddit",
                       source_id="ins-target", title="新条目", reddit_score=200)
            session.add(row)
            await session.commit()
            new_id = row.id
        await registry.pipeline.engine.process_one("score", new_id)
    finally:
        registry.pipeline.engine.ai = old_engine_ai

    assert seen, "score 未调用 LLM"
    system_text = " ".join(seen[0])
    assert "受众偏好" in system_text and "动物" in system_text


# ---------- 时长作为第二个成本维度（v0.38） ----------

@pytest.mark.asyncio
async def test_duration_reported_even_when_cost_is_zero():
    """本地模型 cost 恒为 0 时，**时长必须仍然被报出来**。

    ## 为什么这条是地基级的

    项目定位是 local-first，推荐配置是本地 ollama。而 `estimate_cost` 对本地
    模型返回 0 ——于是「条目成本 ROI」整张表对真正的目标用户恒为 ¥0，全无意义。

    时长一直在 `ai_calls.duration_ms` 里，只是没人读。它才是本地用户真实的
    成本：不是钱，是**等了多久**。
    """
    from datetime import UTC, datetime, timedelta

    from backend.ai.costs import aggregate_costs

    now = datetime.now(UTC)
    async with session_factory() as session:
        for i in range(3):
            session.add(AICall(
                model_key="local/ollama-q4", provider_key="ollama",
                caller="score", operation="chat",
                prompt_tokens=1000, completion_tokens=500,
                duration_ms=40_000 + i * 1000,
                created_at=now - timedelta(hours=1),
            ))
        await session.commit()

    # 空价目表 → 本地模型记 0 元：正是推荐配置下的真实形态
    rep = await aggregate_costs(days=30, prices={})
    assert rep["summary"]["total_cost"] == 0.0, "本地推理不该计钱"
    assert rep["summary"]["duration_ms"] == 123_000, "但时长必须如实报出"
    assert rep["summary"]["avg_duration_ms"] == 41_000

    # 桶里也要有——「按模型」那张表同样要能看出谁最耗时间
    buckets = rep["by_model"]
    local = next(b for b in buckets if b["model_key"] == "local/ollama-q4")
    assert local["duration_ms"] == 123_000
    # 桶的 cost 可能是 None（未配价时整桶置空）也可能是 0.0 —— 金额这一维
    # 本身就是不可靠的。时长那一维没有这个歧义，这正是它该被加进来的理由。
    assert local["cost"] in (None, 0.0)


@pytest.mark.asyncio
async def test_item_roi_carries_duration():
    """每条视频的 ROI 要带自己的时长——这是「这条花了多少时间」的唯一落点。"""
    from datetime import UTC, datetime, timedelta

    from backend.ai.costs import aggregate_costs

    now = datetime.now(UTC)
    async with session_factory() as session:
        row = Item(status=ItemStatus.PUBLISHED, source="test", source_id="roi-1",
                   title="时长可见的条目")
        session.add(row)
        await session.flush()
        iid = str(row.id)
        session.add(AICall(
            model_key="local/ollama-q4", provider_key="ollama",
            task_id=f"item:{iid}", caller="score", operation="chat",
            prompt_tokens=100, completion_tokens=50, duration_ms=12_345,
            created_at=now - timedelta(hours=1),
        ))
        await session.commit()

    rep = await aggregate_costs(days=30, prices={})
    mine = next(r for r in rep["items"] if r["item_id"] == iid)
    assert mine["ai_duration_ms"] == 12_345, "ROI 行必须带时长，否则本地用户的表是空的"
