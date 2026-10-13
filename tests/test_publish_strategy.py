"""发布策略引擎（v0.13）契约测试：B 站账号健康度 + 内容分层 + 动态配额/槽位。

逆向算法解析的规则集全部参数化在 strategy.py 纯函数中——本文件锁定行为：

1. account_state 四相位判定：warmup(新号爬坡)/normal/caution(环比骤降)/cooldown(地板播放)
2. daily_quota 相位系数：cooldown=0 / caution 减半 / warmup 逐级爬坡 / normal=base
3. content_tier 三分层：premier(AI 分高)/regular/filler(lowscore)
4. plan_promotions：tier 优先序 × 配额截断 × 同分区最小间隔 × 相邻分区去重
5. 数据不足不惩罚（<3 条发布 → normal）
"""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from backend.pipeline.strategy import (
    PHASE_CAUTION,
    PHASE_COOLDOWN,
    PHASE_NORMAL,
    PHASE_WARMUP,
    TIER_FILLER,
    TIER_PREMIER,
    TIER_REGULAR,
    StrategyConfig,
    account_state,
    content_tier,
    daily_quota,
    plan_promotions,
)

NOW = datetime(2026, 8, 22, 12, 0, tzinfo=UTC)
CFG = StrategyConfig(enabled=True)


class FakePub:
    """已发布条目桩：published_at + publish_json.stats（回捞数据）。"""

    def __init__(self, published_at: datetime, views: int, likes: int = 0) -> None:
        self.published_at = published_at
        self.publish_json = {"stats": {"view": views, "like": likes}}


def _pub(days_ago: int, hour: int, views: int) -> FakePub:
    return FakePub(NOW - timedelta(days=days_ago, hours=NOW.hour - hour), views)


# ---------- account_state ----------


def test_account_state_warmup_when_few_total_published() -> None:
    """累计发布 < warmup_floor → 新号爬坡期。"""
    pubs = [_pub(d, 20, views=500) for d in range(1, 6)]  # 5 条，播放健康
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_WARMUP
    assert state.total_published == 5


def test_account_state_normal_with_enough_history() -> None:
    """累计 ≥ floor 且近两周播放平稳 → normal。"""
    pubs = [_pub(d % 14, 20, views=1000) for d in range(40)]  # 40 条铺满两周
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_NORMAL


def test_account_state_caution_on_week_over_week_drop() -> None:
    """本周均播较上周降幅超阈值（<0.5）→ caution。"""
    pubs = [_pub(d, 20, views=(2000 if d >= 7 else 600)) for d in range(14)]
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_CAUTION
    assert any("下降" in r or "降" in r for r in state.reasons)


def test_account_state_cooldown_on_floor_views_streak() -> None:
    """最近连续 2 个发布日中位播放 < 地板线（疑似限流）→ cooldown。"""
    pubs = [
        # 两周健康历史（老数据）
        *[_pub(d, 20, views=1500) for d in range(2, 14)],
        # 最近两个发布日地板播放
        _pub(0, 20, views=5),
        _pub(1, 20, views=8),
    ]
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_COOLDOWN


def test_account_state_insufficient_data_not_punished() -> None:
    """发布 <3 条：无历史可判——normal，不因新手期数据稀薄误伤。"""
    pubs = [_pub(0, 20, views=2), _pub(1, 20, views=3)]
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_NORMAL


def test_cooldown_takes_priority_over_warmup() -> None:
    """新号 + 疑似限流并存 → 取更保守的 cooldown。"""
    pubs = [_pub(0, 20, views=3), _pub(1, 20, views=4), _pub(2, 20, views=800)]
    state = account_state(pubs, now=NOW, cfg=CFG)
    assert state.phase == PHASE_COOLDOWN


# ---------- daily_quota ----------


def test_daily_quota_phase_factors() -> None:
    from backend.pipeline.strategy import AccountState

    base = StrategyConfig(enabled=True, base_daily=4)
    assert daily_quota(AccountState(PHASE_NORMAL, 50, (), ()), cfg=base) == 4
    assert daily_quota(AccountState(PHASE_CAUTION, 50, (), ()), cfg=base) == 2
    assert daily_quota(AccountState(PHASE_COOLDOWN, 50, (), ()), cfg=base) == 0


def test_daily_quota_warmup_ramp_by_total_published() -> None:
    """warmup 按累计数爬坡：1..9 条→1 条/日；10..19→2；封顶 base_daily。"""
    from backend.pipeline.strategy import AccountState

    base = StrategyConfig(enabled=True, base_daily=3, warmup_floor=30)
    assert daily_quota(AccountState(PHASE_WARMUP, 5, (), ()), cfg=base) == 1
    assert daily_quota(AccountState(PHASE_WARMUP, 15, (), ()), cfg=base) == 2
    assert daily_quota(AccountState(PHASE_WARMUP, 29, (), ()), cfg=base) == 3  # 封顶


# ---------- content_tier ----------


def test_content_tier_three_levels() -> None:
    class It:
        def __init__(self, score=None, lowscore=False):
            self.score_total = score
            self.is_lowscore = lowscore

    assert content_tier(It(score=8.5)) == TIER_PREMIER
    assert content_tier(It(score=6.0)) == TIER_REGULAR
    assert content_tier(It(score=None)) == TIER_REGULAR  # 直下条目不惩罚
    assert content_tier(It(score=5.0, lowscore=True)) == TIER_FILLER


# ---------- plan_promotions ----------


class Hold:
    """holding 候选桩。"""

    def __init__(self, id_: str, tid: int, score=None, lowscore=False, seq: int = 0):
        self.id = id_
        self.bili_tid = tid
        self.score_total = score
        self.is_lowscore = lowscore
        self.seq = seq


def test_plan_respects_quota_and_tier_order() -> None:
    """quota 截断 + premier 优先于 regular/filler 占槽。"""
    holding = [
        Hold("f1", 21, score=5.0, lowscore=True, seq=1),   # filler
        Hold("p1", 17, score=9.0, seq=2),                   # premier
        Hold("r1", 171, score=6.5, seq=3),                  # regular
        Hold("r2", 122, score=7.0, seq=4),
    ]
    windows = "10:00-23:00"  # 宽窗口保证有槽
    plan = plan_promotions(
        holding, quota=2, existing_ready=[],
        now=NOW, windows_raw=windows, min_interval_min=60, cfg=CFG,
    )
    assert [it.id for it, _slot in plan] == ["p1", "r1"]  # tier 序 + quota=2


def test_plan_same_tid_gap_and_adjacent_diversity() -> None:
    """同分区最小间隔强制错开；相邻两条尽量不同分区。"""
    holding = [
        Hold("a", 21, seq=1),
        Hold("b", 21, seq=2),
        Hold("c", 190, seq=3),
    ]
    plan = plan_promotions(
        holding, quota=3, existing_ready=[],
        now=NOW, windows_raw="10:00-22:00", min_interval_min=30, cfg=CFG,
    )
    assert len(plan) == 3
    times = {it.id: slot for it, slot in plan}
    # 同 tid 的 a/b 间隔 ≥ min_same_tid_gap_h（默认 6h）
    gap_h = abs((times["b"] - times["a"]).total_seconds()) / 3600
    assert gap_h >= CFG.min_same_tid_gap_h
    # 相邻分配不同 tid：a(21) 之后不应紧跟 b(21)
    order = [it.id for it, _ in plan]
    tids_in_order = [next(h.bili_tid for h in holding if h.id == i) for i in order]
    assert tids_in_order[0] != tids_in_order[1]


def test_plan_zero_quota_returns_empty() -> None:
    """cooldown 日配额 0 → 不转正任何条目。"""
    plan = plan_promotions([Hold("x", 21)], quota=0, existing_ready=[],
                           now=NOW, windows_raw="10:00-20:00", cfg=CFG)
    assert plan == []


def test_plan_stops_when_windows_exhausted() -> None:
    """窗口排满（lookahead 内无槽）→ 停止，剩余保持 holding。"""
    holding = [Hold(f"h{i}", 21 + i, seq=i) for i in range(10)]
    plan = plan_promotions(
        holding, quota=10, existing_ready=[],
        now=NOW, windows_raw="10:00-11:00", min_interval_min=120, cfg=CFG,
    )
    assert 0 < len(plan) < 10  # 窗口只装得下部分


# ---------- service 集成（策略开启接管转正；关闭走原路径） ----------


async def _mk(status: str, **kw):
    from backend.models.item import Item
    from backend.models.session import session_factory

    sid = kw.pop("sid")
    async with session_factory() as session:
        row = Item(status=status, source="reddit", source_id=f"pst-{sid}", title="t", **kw)
        session.add(row)
        await session.commit()
        return row.id


@pytest.fixture(autouse=True)
async def _clean_pst_items():
    """本文件条目 source_id 统一 pst- 前缀——测试后清除。

    conftest 无 per-test 清表：残留的 holding 条目会被后续集成测试的
    转正逻辑抢先选中（seq 更小），造成断言错位。"""
    yield
    from sqlalchemy import delete

    from backend.models.item import Item
    from backend.models.session import session_factory

    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source_id.like("pst-%")))
        await session.commit()


def _svc():
    from backend.config import settings as app_settings
    from backend.infrastructure.events import EventHub
    from backend.pipeline.engine import StepEngine
    from backend.pipeline.service import PipelineService

    hub = EventHub()
    return PipelineService(hub=hub, engine=StepEngine(hub=hub, settings=app_settings))


@pytest.mark.asyncio
async def test_strategy_cooldown_blocks_promotion(client) -> None:
    """cooldown 日：quota=0 → 不转正任何 holding 条目（全自动停发）。"""
    from backend.config import runtime_config
    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory as sf
    from backend.pipeline.publish_queue import PHASE_HOLDING

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_strategy_enabled": True,
        "pipeline_auto_promote_daily": 5,
    })
    svc = _svc()
    now = datetime.now(UTC)
    # 近两日地板播放 → cooldown（3 条历史满足最少数据要求）
    for i, (days_ago, views) in enumerate([(0, 4), (1, 6), (2, 900)]):
        await _mk(
            ItemStatus.PUBLISHED, sid=f"scd-{i}",
            published_at=now - timedelta(days=days_ago),
            publish_json={"stats": {"view": views}},
        )
    hold_id = await _mk(ItemStatus.APPROVED, sid="scd-hold")
    async with sf() as session:
        row = await session.get(Item, hold_id)
        row.queue_phase = "holding"
        await session.commit()

    promoted = await svc._auto_promote_now(now)
    assert promoted == 0
    async with sf() as session:
        row = await session.get(Item, hold_id)
        assert row.queue_phase == PHASE_HOLDING


@pytest.mark.asyncio
async def test_strategy_normal_promotes_by_tier(client) -> None:
    """normal 相位：配额 = base_daily，tier 序选条目（premier 先占槽）。"""
    from backend.config import runtime_config
    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory as sf
    from backend.pipeline.publish_queue import PHASE_READY

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_strategy_enabled": True,
        "pipeline_strategy_base_daily": 2,
    })
    svc = _svc()
    now = datetime.now(UTC)
    for i in range(10):  # 累计 ≥ warmup_floor 且播放平稳 → normal
        await _mk(
            ItemStatus.PUBLISHED, sid=f"nm-{i}",
            published_at=now - timedelta(days=i % 14 + 1),
            publish_json={"stats": {"view": 1200 + i}},
        )
    ids = {
        "filler": await _mk(ItemStatus.APPROVED, sid="t-f", score_total=5.0, is_lowscore=True),
        "premier": await _mk(ItemStatus.APPROVED, sid="t-p", score_total=9.2),
        "regular": await _mk(ItemStatus.APPROVED, sid="t-r", score_total=6.5),
    }
    async with sf() as session:
        for iid in ids.values():
            row = await session.get(Item, iid)
            row.queue_phase = "holding"
        await session.commit()

    promoted = await svc._auto_promote_now(now)
    assert promoted == 2  # base_daily=2
    async with sf() as session:
        phases = {k: (await session.get(Item, v)).queue_phase for k, v in ids.items()}
    assert phases["premier"] == PHASE_READY
    assert phases["regular"] == PHASE_READY
    assert phases["filler"] == "holding"  # 配额外保持囤货


@pytest.mark.asyncio
async def test_strategy_disabled_keeps_legacy_behavior(client) -> None:
    """总开关关闭：转正走 auto_promote_daily 静态数，与 v0.12 行为一致。"""
    from backend.config import runtime_config
    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory as sf
    from backend.pipeline.publish_queue import PHASE_HOLDING, PHASE_READY

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_auto_promote_daily": 1,
        "pipeline_strategy_enabled": False,
    })
    svc = _svc()
    now = datetime.now(UTC)
    pair = [await _mk(ItemStatus.APPROVED, sid=f"lg-{i}") for i in range(2)]
    async with sf() as session:
        for iid in pair:
            row = await session.get(Item, iid)
            row.queue_phase = "holding"
        await session.commit()

    promoted = await svc._auto_promote_now(now)
    assert promoted == 1  # 静态转正数生效（策略未接管）
    async with sf() as session:
        phases = [(await session.get(Item, iid)).queue_phase for iid in pair]
    assert phases.count(PHASE_READY) == 1
    assert phases.count(PHASE_HOLDING) == 1


@pytest.mark.asyncio
async def test_strategy_dry_run_records_shadow_plan(client) -> None:
    """影子模式：照常计算计划但不落库——holding 保持、shadow_plan 有记录。"""
    from backend.config import runtime_config
    from backend.models.item import Item, ItemStatus
    from backend.models.session import session_factory as sf

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_strategy_enabled": True,
        "pipeline_strategy_base_daily": 2,
        "pipeline_strategy_dry_run": True,
    })
    svc = _svc()
    now = datetime.now(UTC)
    for i in range(10):
        await _mk(
            ItemStatus.PUBLISHED, sid=f"sh-{i}",
            published_at=now - timedelta(days=i % 14 + 1),
            publish_json={"stats": {"view": 1200 + i}},
        )
    hold_id = await _mk(ItemStatus.APPROVED, sid="sh-hold", score_total=9.0)
    async with sf() as session:
        row = await session.get(Item, hold_id)
        row.queue_phase = "holding"
        await session.commit()

    from backend.pipeline.publish_queue import PHASE_HOLDING

    promoted = await svc._strategy_promote(now)
    assert promoted == 0  # 影子：不落库
    async with sf() as session:
        row = await session.get(Item, hold_id)
        assert row.queue_phase == PHASE_HOLDING  # 保持囤货
    shadow = getattr(svc, "_shadow_plan", [])
    assert len(shadow) >= 1
    assert "scheduled_at" in shadow[0] and "title" in shadow[0]


# ---------- premier 门槛真的接在判定上（v0.37） ----------

def test_content_tier_respects_premier_threshold():
    """`premier_score` 必须真的改变 tier 判定，而不只是被读进 StrategyConfig。

    v0.37 之前 `content_tier` 里硬编码 8.0、签名里根本没有门槛参数。于是设置页
    调 `pipeline_strategy_premier_score` 时配置变了、判定纹丝不动——用户调完
    没有任何效果，却看不出哪里没生效。
    """
    item = SimpleNamespace(score_total=8.5, is_lowscore=False)
    # 默认门槛 8.0 → premier
    assert content_tier(item, 8.0) == TIER_PREMIER
    # 门槛抬到 9.0 → 掉到 regular
    assert content_tier(item, 9.0) == TIER_REGULAR
    # 门槛压到 6.0 → 仍是 premier
    assert content_tier(item, 6.0) == TIER_PREMIER


def test_content_tier_threshold_does_not_override_lowscore():
    """lowscore 永远 filler——门槛再低也不能把它抬成 premier。"""
    item = SimpleNamespace(score_total=99.0, is_lowscore=True)
    assert content_tier(item, 0.1) == TIER_FILLER


def test_plan_promotions_orders_by_configured_premier_score():
    """排序是 tier 判定唯一真正影响行为的地方：不传门槛，用户调设置就完全无效。

    两条候选都够 premier 门槛（默认 8.0）：A=8.5、B=9.5。
    - 门槛 8.0：B 和 A 都是 premier，按 seq 决定先后
    - 门槛 9.0：B 是 premier、A 掉到 regular → **B 必须排到 A 前面**，
      哪怕 A 的 seq 更小。这正是「调高 premier_score 让高潜条目优先」的意义。
    """
    now = datetime(2026, 1, 1, 9, 0, tzinfo=UTC)
    hi = SimpleNamespace(seq=1, score_total=8.5, is_lowscore=False, bili_tid=1, seq_score=None)
    lo = SimpleNamespace(seq=2, score_total=9.5, is_lowscore=False, bili_tid=2, seq_score=None)
    holding = [hi, lo]

    base = dict(
        quota=2,
        existing_ready=[],
        now=now,
        # 宽窗口 + 无间隔限制，让两条都能排进去（只考察排序，不考察窗口）
        windows_raw="00:00-23:59",
        min_interval_min=0,
    )
    cfg_lo = StrategyConfig(enabled=True, premier_score=8.0)
    cfg_hi = StrategyConfig(enabled=True, premier_score=9.0)

    order_default = [it.seq for it, _dt in plan_promotions(holding, cfg=cfg_lo, **base)]
    order_raised = [it.seq for it, _dt in plan_promotions(holding, cfg=cfg_hi, **base)]

    assert order_default == [1, 2], "同档时按 seq"
    assert order_raised == [2, 1], (
        f"premier_score 抬到 9.0 后高分条目应优先，实际 {order_raised}——"
        "门槛没有接进排序"
    )


# ---------- 跨日排期：设置必须真的生效（v0.38 回归） ----------

def test_lookahead_days_reads_settings():
    """`pipeline_publish_lookahead_days` 必须真的改变 `next_slot` 的排期跨度。

    ## 为什么这条测试必须存在

    v0.37 之前配置里有这个字段而代码**零读取**——6 处调用点全硬传 1，用户改了
    完全没反应。那种「看得见、调不了」的旋钮比没有更糟。

    v0.37 我把字段删了（当时判断：v0.11.5「只排当天」是刻意约束）。v0.38 加回来，
    这次每个调用点都真读它——**而且默认仍是 1**，所以不配置时行为与 v0.11.5 逐字
    一致，变的是用户主动调大时能生效。
    """
    from backend.pipeline.schedule import _lookahead_days

    class _Cfg:
        def __init__(self, v):
            self.pipeline_publish_lookahead_days = v

    assert _lookahead_days(_Cfg(1)) == 1
    assert _lookahead_days(_Cfg(7)) == 7
    # 非法值钳到 1：填 0/负数是笔误，不该产生「0 天排期」这种无意义配置
    assert _lookahead_days(_Cfg(0)) == 1
    assert _lookahead_days(_Cfg(-3)) == 1
    assert _lookahead_days(_Cfg("abc")) == 1


def test_lookahead_actually_extends_the_scheduling_horizon():
    """窗口排满时，lookahead 决定**能否往后找几天**——这才是它的实际作用。

    别被「窗口错过 → 兜底到 now + 最小间隔」误导：那是兜底路径，与 lookahead
    无关。真正的差别发生在**已排期把当天窗口彻底占满**时：

    - `earliest` 被推出今天的窗口 → lookahead=1 只看这一天，找不到 → 兜底条件
      「earliest 仍与 now 同日」不成立 → 返回 **None**，调用方保持无排期；
    - lookahead=7 则会往后找 7 天，找到下一个可用窗口。

    也就是说：lookahead=1 时**你无法制定超过 24 小时的计划**——库存里躺着一条
    该发的内容，它也不会被排到后天去。

    断言用「本地日差」而非日期字面量：`next_slot` 按**系统本地时区**解释窗口
    （v0.11.5 刻意的墙钟语义），拿 UTC 日期去断言会在非 UTC 机器上假红。
    """
    from backend.pipeline.schedule import next_slot

    local = datetime.now().astimezone().tzinfo
    today = datetime.now().astimezone(local).replace(
        hour=0, minute=0, second=0, microsecond=0)
    # 占用放在今天之后一点的时刻：earliest = 占用 + min_interval，必然跨出今天
    occupied = [today.replace(hour=23, minute=40)]

    same_day = next_slot(
        occupied, now=today,
        windows_raw="00:00-01:00", min_interval_min=60, lookahead_days=1,
    )
    assert same_day is None, (
        f"lookahead=1 时窗口排满应当返回 None（保持无排期、等用户手动设），实际 {same_day}"
    )

    a_week = next_slot(
        occupied, now=today,
        windows_raw="00:00-01:00", min_interval_min=60, lookahead_days=7,
    )
    assert a_week is not None, "lookahead=7 应当能往后找到下一个可用窗口"
    span_days = (
        a_week.astimezone(local).date() - occupied[0].astimezone(local).date()
    ).days
    assert 1 <= span_days <= 7, f"应排到 1~7 天内，实际 {span_days} 天"


def test_no_hardcoded_lookahead_left_in_production_call_sites():
    """源码级守卫：生产调用点不得再出现 `lookahead_days=1`。

    这条针对的正是 v0.37 那个洞：字段存在、六处硬编码、用户改了没反应。
    只测 `_lookahead_days` 函数不够——它可能压根没人调用（那正是当初的形状）。
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "backend/pipeline"
    offenders = [
        f"{p.name}:{i}"
        for p in root.glob("service_*.py")
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if "lookahead_days=1" in line
    ]
    assert not offenders, f"这些生产调用点仍硬编码 lookahead：{offenders}"
