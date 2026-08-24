"""运行遥测端点（v0.22 可见性补全）：进程快照 + 调度 tick 历史 + 备份状态。

轻量 JSON（非 Prometheus 格式）——桌面单用户场景，前端「运行健康」消费。
"""

from fastapi import APIRouter

from backend.config import APP_VERSION
from backend.infrastructure.backup import last_backup_info
from backend.infrastructure.telemetry import snapshot

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("")
async def metrics() -> dict:
    snap = snapshot()
    return {
        "version": APP_VERSION,
        "uptime_s": snap["uptime_s"],
        "started_at": snap["started_at"],
        "ticks": snap["ticks"],
        "backup": last_backup_info(),
    }
