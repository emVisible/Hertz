"""Health endpoints: layered checks (DB, AI providers)."""

from fastapi import APIRouter

from backend.factory.registry import ServiceRegistry
from backend.infrastructure.health import run_health_checks

router = APIRouter(tags=["health"])


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
    return report.to_dict()
