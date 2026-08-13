"""Dependency status endpoints (v0.8.8).

GET  /api/deps         读缓存（不检测——运行时零探测）
POST /api/deps/check   手动重新检测（设置页按钮触发）
"""

from fastapi import APIRouter

from backend.infrastructure.deps import load_dependencies, refresh_dependencies

router = APIRouter(tags=["deps"])


@router.get("/deps")
async def get_deps() -> dict:
    data = load_dependencies()
    if data is None:
        # 缓存缺失（理论只在启动预热前发生）：补测一次
        data = await refresh_dependencies()
    return data


@router.post("/deps/check")
async def recheck_deps() -> dict:
    return await refresh_dependencies()
