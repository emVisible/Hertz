"""发布域：publish/publish-status/发布数据回捞。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_publish.router 由 pipeline 聚合 include）。
"""

import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import settings
from backend.errors import HertzError
from backend.factory.registry import ServiceRegistry
from backend.pipeline.publishers.router import PUBLISHERS

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline

class PublishStatsBody(BaseModel):
    view: int = 0
    like: int = 0
    favorite: int = 0
    comment: int = 0
    share: int = 0


@router.post("/items/{item_id}/publish-stats")
async def set_publish_stats(item_id: uuid.UUID, body: PublishStatsBody) -> dict:
    """手动补录发布数据（v0.4 C1：自动回捞失败时的降级入口）。"""
    return await _pipe().set_publish_stats(item_id, body.model_dump())


@router.post("/items/{item_id}/publish")
async def publish_item(item_id: uuid.UUID, selfmade: int = 0, target: str = "", now: int = 0):
    """发布：404/409 由全局 handler 映射；执行失败（缺 cookie/文件等）→ 502。
    v0.11.5：now=1（立即发布）→ 清除 scheduled_at 按当前时间上传。"""
    try:
        return await _pipe().publish_one(
            item_id, selfmade=bool(selfmade), target=target.strip() or None, now=bool(now)
        )
    except HertzError:
        raise
    except Exception as exc:  # noqa: BLE001 — 发布失败返回可读错误
        raise HTTPException(status_code=502, detail=f"发布失败：{exc}") from exc


@router.get("/publish/status")
async def publish_status() -> dict:
    """发布健康状态（v0.3.8）：生效目标 + B 站 cookie 就绪度 + biliup 可用性。"""
    from pathlib import Path

    target = getattr(settings, "pipeline_publish_target", "noop")
    cookie_path = Path(settings.data_dir) / "core" / "cookies.json"
    try:
        cookie_exists = cookie_path.exists()
        cookie_age_s = (
            int(__import__("time").time() - cookie_path.stat().st_mtime)
            if cookie_exists
            else None
        )
    except Exception:  # noqa: BLE001 — 状态检查 best-effort
        cookie_exists, cookie_age_s = False, None
    # v0.8.8：biliup 可用性读 deps 缓存（启动/设置页手动检测），不再每次轮询 which
    from backend.infrastructure.deps import dep_ok, load_dependencies

    biliup = dep_ok(load_dependencies(), "biliup")
    return {
        "target": target,
        "biliup_available": biliup,
        "cookie_exists": cookie_exists,
        "cookie_path": str(cookie_path),
        "cookie_age_s": cookie_age_s,
        "publishers": list(PUBLISHERS),
        # noop 目标下发布只是记录意图——前端据此刻意警示
        "noop": target == "noop",
    }


