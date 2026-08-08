"""Local publish schedule engine (Autarkeia heritage, scheduler_utils).

与「平台侧定时」（biliup --timedpublish，B 站到点开播）互补：本地侧负责
「选槽」——在配置的每日发布窗口内，按最小间隔与抖动给出下一个推荐排期，
避免同一窗口内稿件扎堆。推荐结果可直接写回 item.scheduled_at。

配置（backend/config.py）：
- pipeline_publish_windows: 每日窗口，逗号分隔 "HH:MM-HH:MM"（默认 10:00-12:00,18:00-20:00）
- pipeline_publish_min_interval_min: 相邻发布最小间隔（默认 30 分钟）
- pipeline_publish_jitter_min: 槽位抖动上限（默认 5 分钟，防多机/多条目同时到点）
- pipeline_publish_lookahead_days: 向前看天数（默认 3）
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


def _with_time(day: datetime, t: time) -> datetime:
    return day.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)


def next_slot(
    existing: list[datetime],
    *,
    now: datetime | None = None,
    windows_raw: str = "10:00-12:00,18:00-20:00",
    min_interval_min: int = 30,
    jitter_min: int = 5,
    lookahead_days: int = 3,
) -> datetime:
    """下一个发布槽位：满足 窗口内 + 最小间隔 + 抖动 的最早时刻。

    - 早于所有已排期 + 最小间隔的时间点不可用（防扎堆）
    - 窗口结束后不足 min_interval 的槽位跳过（时间太紧）
    - 抖动：候选时刻 + 0..jitter 分钟随机（确定性测试可传 jitter_min=0）
    """
    windows = parse_windows(windows_raw)
    base = (now or datetime.now(UTC)).astimezone(UTC)
    earliest = base
    if existing:
        latest = max(t.astimezone(UTC) for t in existing)
        earliest = max(base, latest + timedelta(minutes=min_interval_min))

    for day_offset in range(max(lookahead_days, 1)):
        day = base + timedelta(days=day_offset)
        for win in windows:
            window_end = _with_time(day, win.end)
            # 候选 = 窗口起点与 earliest 的较晚者（earliest 可能落在窗口中间）
            candidate = max(_with_time(day, win.start), earliest)
            if candidate >= window_end:
                continue
            if candidate > window_end - timedelta(minutes=min_interval_min):
                continue
            if jitter_min > 0:
                candidate += timedelta(minutes=random.randint(0, jitter_min))
            return candidate

    # 兜底：窗口全满 → 最晚已排期 + 最小间隔（平台侧 dtime 仍兜底）
    return earliest + timedelta(minutes=min_interval_min)
