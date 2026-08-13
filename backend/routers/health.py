"""Health endpoints: layered checks (DB, AI providers).

v0.8.9 AXIOM 6.5：响应带进程检查点（version/started_at/pid）——
「修复了但症状仍在」的第一嫌疑是运行中的实例是旧版本，检查点让
「运行的是什么」可观测、可确认。
"""

import os
from datetime import UTC, datetime

from fastapi import APIRouter

from backend.factory.registry import ServiceRegistry
from backend.infrastructure.health import run_health_checks

router = APIRouter(tags=["health"])

APP_VERSION = "0.8.9"
_PROCESS_STARTED_AT = datetime.now(UTC).isoformat()


@router.get("/health")
async def health() -> dict:
    registry = ServiceRegistry.get()
    ai = registry.ai

    async def _llm_check() -> dict:
        # v2.0：LLM 由注册表驱动，健康状态 = 是否有可用的 chat 模型
        resolved = await registry.providers.resolve_role("main") if registry.providers else None
        if resolved is None:
            return {"configured": False}
        return {
            "configured": True,
            "provider": resolved["provider_key"],
            "model": resolved["model_key"],
        }

    async def _image_check() -> dict:
        if ai is None or not ai.image_available:
            return {"configured": False}
        reachable = await ai.image_reachable()
        if not reachable:
            return {"status": "error", "configured": True, "detail": "ComfyUI unreachable"}
        return {"configured": True, "reachable": True}

    report = await run_health_checks(extra={"llm": _llm_check, "image": _image_check})
    data = report.to_dict()
    # AXIOM 6.5 运行状态检查点：版本 / 进程启动时间 / pid
    data["version"] = APP_VERSION
    data["started_at"] = _PROCESS_STARTED_AT
    data["pid"] = os.getpid()
    return data
