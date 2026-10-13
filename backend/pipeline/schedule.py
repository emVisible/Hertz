"""Local publish schedule engine (Autarkeia heritage, scheduler_utils).

与「平台侧定时」（biliup --timedpublish，B 站到点开播）互补：本地侧负责
「选槽」——在配置的每日发布窗口内，按最小间隔与抖动给出下一个推荐排期，
避免同一窗口内稿件扎堆。推荐结果可直接写回 item.scheduled_at。

配置（backend/config.py）：
- pipeline_publish_windows: 每日窗口，逗号分隔 "HH:MM-HH:MM"（默认 10:00-12:00,18:00-20:00）
- pipeline_publish_min_interval_min: 相邻发布最小间隔（默认 30 分钟）
- pipeline_publish_jitter_min: 槽位抖动上限（默认 5 分钟，防多机/多条目同时到点）

`lookahead_days` **不是 settings 项**，而是本函数的显式参数（v0.37 起）：v0.11.5
的产品决策是「只排当天」，全部生产调用点都传 1。此前它还是一个叫
`pipeline_publish_lookahead_days` 的设置项，却零读取——用户改了完全没反应。
保留为函数参数，需要跨天排期的调用方仍可显式传入。

v0.11.5：默认只排**当天**（用户需求：定时发布不要定太久）；当天窗口
全部错过时兜底 = 最早可用时刻 + 最小间隔（仍在当天）。窗口即流量高峰时段。
"""

import random
from dataclasses import dataclass
from datetime import UTC, datetime, time, timedelta


@dataclass(frozen=True)
class PublishWindow:
    start: time
    end: time


def parse_windows(raw: str) -> list[PublishWindow]:
    windows: list[PublishWindow] = []
    for part in (raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            start_s, end_s = (x.strip() for x in part.split("-"))
            windows.append(PublishWindow(time.fromisoformat(start_s), time.fromisoformat(end_s)))
        except ValueError:
            continue
    return windows


def _lookahead_days(settings_obj) -> int:
    """跨日排期天数：读 `pipeline_publish_lookahead_days`，钳到 ≥1。

    唯一读数入口（v0.38）。此前 6 处调用点各硬传 `lookahead_days=1`，而配置里
    还有一个同名字段零读取——用户改它完全没有反应。

    钳到 ≥1 是因为 `next_slot` 内部 `range(max(lookahead_days, 1))` 也拦着，
    但配置层就该给出合法值：填 0 或负数是用户笔误，不该让「0 天」这种
    无意义配置静默退化成 1。

    默认 1，与 v0.11.5「只排当天」逐字一致；调大它，用户就能制定超过 24 小时的
    排期计划。
    """
    try:
        value = int(getattr(settings_obj, "pipeline_publish_lookahead_days", 1) or 1)
    except (TypeError, ValueError):
        return 1
    return max(1, value)


def next_slot(
    existing: list[datetime],
    *,
    now: datetime | None = None,
    windows_raw: str = "10:00-12:00,18:00-20:00",
    min_interval_min: int = 30,
    jitter_min: int = 5,
    lookahead_days: int = 1,
) -> datetime | None:
    """下一个发布槽位：满足 窗口内 + 最小间隔 + 抖动 的最早时刻；无可用返回 None。

    v0.11.5：
    - lookahead_days 默认 1（只排当天）；窗口错过 → 当天兜底 now + 最小间隔
    - 窗口排满（earliest 被推到次日）→ 返回 None（调用方保持无排期，
      用户手动设）——绝不无限推延到 n 天后
    - 窗口时间 = **本地时钟语义**（用户配置的高峰时段是本地时间），
      用系统本地时区解释窗口再转 UTC 返回
    - 早于所有已排期 + 最小间隔的时间点不可用（防扎堆）
    - 窗口结束后不足 min_interval 的槽位跳过（时间太紧）
    - 抖动：候选时刻 + 0..jitter 分钟随机（确定性测试可传 jitter_min=0）
    """
    windows = parse_windows(windows_raw)
    base = (now or datetime.now(UTC)).astimezone(UTC)
    local_tz = datetime.now().astimezone().tzinfo
    earliest = base
    if existing:
        latest = max(t.astimezone(UTC) for t in existing)
        earliest = max(base, latest + timedelta(minutes=min_interval_min))

    for day_offset in range(max(lookahead_days, 1)):
        # v0.11.5：从 earliest 所在日开始找窗口（earliest 可能已被已排期
        # 条目推到未来——从「今天」起算会让 1 天 lookahead 找不到窗口）
        local_day = (earliest.astimezone(local_tz) + timedelta(days=day_offset)).date()
        for win in windows:
            day_start = datetime.combine(local_day, time.min, tzinfo=local_tz)
            win_start_dt = day_start + timedelta(hours=win.start.hour, minutes=win.start.minute)
            win_end_dt = day_start + timedelta(hours=win.end.hour, minutes=win.end.minute)
            window_start = win_start_dt.astimezone(UTC)
            window_end = win_end_dt.astimezone(UTC)
            # 候选 = 窗口起点与 earliest 的较晚者（earliest 可能落在窗口中间）
            candidate = max(window_start, earliest)
            if candidate >= window_end:
                continue
            if candidate > window_end - timedelta(minutes=min_interval_min):
                continue
            if jitter_min > 0:
                candidate += timedelta(minutes=random.randint(0, jitter_min))
            return candidate

    # 兜底：仅在「今天」内有效（v0.11.5：定时发布不要定太久）——
    # 当天窗口已错过 → now + 最小间隔（当天内）；earliest 已被推到明天
    # （窗口排满）→ 无可用槽位返回 None，调用方保持无排期（用户手动设），
    # 绝不无限推延到 n 天后。
    if earliest.astimezone(local_tz).date() == base.astimezone(local_tz).date():
        return earliest + timedelta(minutes=min_interval_min)
    return None
