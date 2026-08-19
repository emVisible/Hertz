"""Publish queue domain (v0.12): phase constants + pure helpers.

单一真相源：queue_phase 的语义（models/item.py 注释与 QUEUE_PHASES 一致），
服务层（PipelineService）只引用本模块常量与纯函数，不做内联字面量。

语义：
- PHASE_NONE / ''      = 不入队（纯手动发布，不参与自动发布/产能）
- PHASE_HOLDING        = 预发布队列：囤着待命，无排期，不自动分槽/发布
- PHASE_READY          = 发布队列：必须有 scheduled_at，到点由 auto_publish tick 发布
"""

from datetime import UTC, datetime, timedelta

PHASE_NONE = ""
PHASE_HOLDING = "holding"
PHASE_READY = "ready"

# 合法入队目标（'' = 出队）
QUEUE_PHASES = (PHASE_NONE, PHASE_HOLDING, PHASE_READY)


def local_day_bounds(now: datetime | None = None) -> tuple[datetime, datetime]:
    """系统本地日 → (本地零点 UTC, 次日零点 UTC)。

    产能按本地日切（与 schedule.py 窗口的本地时钟语义一致），
    返回 UTC 边界供 SQL 区间查询。
    """
    base = now or datetime.now(UTC)
    local_tz = datetime.now().astimezone().tzinfo
    local = base.astimezone(local_tz)
    day_start = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return (
        day_start.astimezone(UTC),
        (day_start + timedelta(days=1)).astimezone(UTC),
    )