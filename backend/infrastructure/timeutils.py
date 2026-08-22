"""Time utilities: 本地日切的单一权威实现（v0.14 收敛——此前
strategy/costs/service/pipeline_items 四处各自内联同构逻辑）。"""

from datetime import datetime


def local_day_str(dt: datetime) -> str:
    """UTC/aware 时间 → 本地日字符串 YYYY-MM-DD（与产能/排期/成本口径一致）。"""
    return dt.astimezone().date().isoformat()
