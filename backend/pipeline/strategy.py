"""Publish strategy engine (v0.13): B 站「逆向算法」发布策略——纯函数核心。

把精细化运营的规则集参数化：什么样的号（warmup/normal）、什么状态
（caution/cooldown）、今天该发几条（quota）、发哪条（tier 优先）、几点发
（槽位 + 同分区间隔 + 相邻分区去重）。每个决策附带 reasons 人话证据。

设计约束（AXIOM）：
- 纯函数、零 IO、零持久化——账号状态是 items 表 + publish_json.stats 的
  派生数据，实时推导，单一真相源不变
- 总开关 pipeline_strategy_enabled=False 时 service 走原路径，本模块不被调用
- 时间口径与 publish_queue.local_day_bounds 一致：本地日切

判定规则（v1 规则版，民间共识参数化，非 ML）：
- cooldown：最近连续 N 个发布日的中位播放 < 地板线（疑似限流）→ 停发
- caution：本周均播 / 上周均播 < drop_ratio（流量骤降）→ 减半
- warmup：累计发布 < warmup_floor → 按累计数爬坡（新号高频 = 异常判定）
- normal：其余；数据不足（<3 条）不惩罚
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from backend.infrastructure.timeutils import local_day_str
from backend.pipeline.schedule import next_slot

# ---------- 相位与分层常量 ----------

PHASE_WARMUP = "warmup"
PHASE_NORMAL = "normal"
PHASE_CAUTION = "caution"
PHASE_COOLDOWN = "cooldown"

TIER_PREMIER = "premier"
TIER_REGULAR = "regular"
TIER_FILLER = "filler"

_TIER_ORDER = {TIER_PREMIER: 0, TIER_REGULAR: 1, TIER_FILLER: 2}


@dataclass(frozen=True)
class StrategyConfig:
    """策略参数（来源 settings.pipeline_strategy_*；测试可直接构造）。"""

    enabled: bool = False
    base_daily: int = 2  # 常态日配额（新号保守起步）
    warmup_floor: int = 30  # 累计发布低于此 = 新号爬坡期
    warmup_step: int = 10  # 每 step 条发布 +1 配额，封顶 base_daily
    drop_ratio: float = 0.5  # 本周均播/上周均播 < 此值 → caution
    cooldown_floor_views: int = 10  # 单个发布日中位播放地板线
    cooldown_streak_days: int = 2  # 连续地板天数 → cooldown
    min_same_tid_gap_h: int = 6  # 同分区间隔下限（防堆量痕迹）
    premier_score: float = 8.0  # premier AI 分门槛


@dataclass(frozen=True)
class DayStat:
    """单本地日的发布表现聚合。"""

    date: str  # YYYY-MM-DD（本地日）
    uploads: int
    views_median: float | None  # None = 当日无回捞数据


@dataclass(frozen=True)
class AccountState:
    """账号画像快照（派生数据，不落库）。"""

    phase: str
    total_published: int
    days: tuple[DayStat, ...]  # 近期逐日聚合（旧→新）
    reasons: tuple[str, ...]  # 判定证据（中文人话，前端直显）


# ---------- 账号状态推导 ----------


def _day_stats(published: list, now: datetime) -> list[DayStat]:
    """按本地日聚合已发布条目的播放中位数（旧→新）。"""
    buckets: dict[str, list[int]] = {}
    for it in published:
        pub_at = getattr(it, "published_at", None)
        if pub_at is None:
            continue
        stats = (getattr(it, "publish_json", None) or {}).get("stats") or {}
        views = stats.get("view")
        buckets.setdefault(local_day_str(pub_at), []).append(int(views or 0))
    out: list[DayStat] = []
    for date in sorted(buckets):
        vs = sorted(buckets[date])
        mid = vs[len(vs) // 2] if len(vs) % 2 else (vs[len(vs) // 2 - 1] + vs[len(vs) // 2]) / 2
        out.append(DayStat(date=date, uploads=len(vs), views_median=float(mid)))
    return out


def account_state(
    published: list, *, now: datetime, cfg: StrategyConfig,
    total_published: int | None = None,
) -> AccountState:
    """从已发布条目推导账号相位（纯函数；published 为 ORM Item 或同形桩）。

    total_published：账号累计发布总数——warmup 判定的依据。调用方若只传入
    近期窗口的明细，须另传全量计数，避免低频老号被误判为新号。
    """
    total = total_published if total_published is not None else len(published)
    days = tuple(_day_stats(published, now))

    if total < 3:
        return AccountState(
            PHASE_NORMAL, total, days,
            reasons=(f"发布记录不足 {total}/3 条，暂不评估健康度",),
        )

    # cooldown：最近连续 N 个发布日地板播放（疑似限流）
    streak = 0
    for d in reversed(days):
        if d.uploads == 0:
            break  # 只看最近的连续发布段
        if d.views_median is not None and d.views_median < cfg.cooldown_floor_views:
            streak += 1
        else:
            break
    if streak >= cfg.cooldown_streak_days:
        return AccountState(
            PHASE_COOLDOWN, total, days,
            reasons=(
                f"最近 {streak} 个发布日中位播放 < {cfg.cooldown_floor_views}，疑似被限流——"
                f"自动停发 {cfg.cooldown_streak_days} 天观察",
            ),
        )

    # caution：完整两周数据且环比骤降
    with_data = [d for d in days if d.views_median is not None and d.uploads > 0]
    if len(with_data) >= 4:
        half = len(with_data) // 2
        prev_avg = sum(d.views_median for d in with_data[:half]) / half
        curr_avg = sum(d.views_median for d in with_data[half:]) / (len(with_data) - half)
        if prev_avg > 0 and curr_avg / prev_avg < cfg.drop_ratio:
            pct = round((1 - curr_avg / prev_avg) * 100)
            return AccountState(
                PHASE_CAUTION, total, days,
                reasons=(
                    f"近几日中位播放较此前下降约 {pct}%——配额减半观察，恢复后自动回升",
                ),
            )

    if total < cfg.warmup_floor:
        return AccountState(
            PHASE_WARMUP, total, days,
            reasons=(
                f"新号爬坡期（{total}/{cfg.warmup_floor} 条）：低频起步逐步加量，"
                "避免高频发布触发异常判定",
            ),
        )

    return AccountState(PHASE_NORMAL, total, days, reasons=("账号状态正常",))


def daily_quota(state: AccountState, *, cfg: StrategyConfig) -> int:
    """今日动态配额：phase 系数 × 爬坡曲线。"""
    if state.phase == PHASE_COOLDOWN:
        return 0
    if state.phase == PHASE_CAUTION:
        return max(1, cfg.base_daily // 2)
    if state.phase == PHASE_WARMUP:
        ramp = 1 + state.total_published // max(cfg.warmup_step, 1)
        return min(cfg.base_daily, ramp)
    return cfg.base_daily


# ---------- 内容分层 ----------


def _tid_of(item) -> int:
    """分区读取：ORM 字段名 auto_tid（bili_tid 为测试桩/历史别名容错）。"""
    return int(
        getattr(item, "auto_tid", None)
        or getattr(item, "bili_tid", None)
        or 0
    )


def content_tier(item) -> str:
    """premier(AI 分高潜)/regular/filler(lowscore)；无分直下条目按 regular。"""
    if bool(getattr(item, "is_lowscore", False)):
        return TIER_FILLER
    score = getattr(item, "score_total", None)
    if score is not None and float(score) >= 8.0:
        return TIER_PREMIER
    return TIER_REGULAR


# ---------- 槽位规划 ----------


def plan_promotions(
    holding: list,
    *,
    quota: int,
    existing_ready: list[tuple[datetime, int]],
    now: datetime,
    windows_raw: str,
    min_interval_min: int = 30,
    cfg: StrategyConfig | None = None,
    lookahead_days: int = 7,
) -> list[tuple[object, datetime]]:
    """从 holding 选出今日转正条目并分配槽位。

    规则：
    - tier 权重排序（premier 占黄金槽，同级按 seq 入库序）
    - quota 截断；cooldown 日 quota=0 → 空
    - 相邻两条尽量不同分区（多样性）；候选不足时接受重复
    - 同分区间隔 ≥ min_same_tid_gap_h（防堆量标记）
    - 复用 schedule.next_slot（窗口/全局最小间隔/抖动），窗口耗尽即停
      （剩余保持 holding，与既有语义一致）
    """
    cfg = cfg or StrategyConfig(enabled=True)
    if quota <= 0 or not holding:
        return []

    ranked = sorted(
        holding,
        key=lambda it: (_TIER_ORDER[content_tier(it)], getattr(it, "seq", 0)),
    )
    allocated: list[datetime] = [dt for dt, _tid in existing_ready if dt is not None]
    last_by_tid: dict[int, datetime] = {
        int(tid or 0): dt for dt, tid in existing_ready if dt is not None
    }

    plan: list[tuple[object, datetime]] = []
    last_tid: int | None = None
    pending = list(ranked)
    while len(plan) < quota and pending:
        cand = next(
            (x for x in pending if _tid_of(x) != last_tid),
            pending[0],
        )
        pending.remove(cand)
        tid = _tid_of(cand)

        slot = next_slot(
            allocated, now=now, windows_raw=windows_raw,
            min_interval_min=min_interval_min, lookahead_days=lookahead_days,
        )
        if slot is None:
            break  # 窗口排满——剩余保持 holding
        # 同分区间隔强制：与该分区上一条不足 gap → 推后重排
        gap = timedelta(hours=cfg.min_same_tid_gap_h)
        if tid in last_by_tid and slot < last_by_tid[tid] + gap:
            slot = next_slot(
                [*allocated, last_by_tid[tid] + gap], now=now,
                windows_raw=windows_raw, min_interval_min=min_interval_min,
                lookahead_days=lookahead_days,
            )
            if slot is None:
                continue  # 推后仍无槽——跳过该条目试下一个
        plan.append((cand, slot))
        allocated.append(slot)
        last_by_tid[tid] = slot
        last_tid = tid
    return plan
