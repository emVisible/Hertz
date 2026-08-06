"""Config endpoints: read effective config (sanitized), write runtime overrides.

Secrets never leave the backend unmasked (AXIOM §8.2): the API key is only
returned masked; writing it is allowed (single-user desktop, stored in the
local data/runtime.yaml) but reading it back is impossible.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import runtime_config, settings

router = APIRouter(prefix="/config", tags=["config"])

# Fields allowed for runtime override (public, non-secret, UI-adjustable)
RUNTIME_ALLOWLIST = {
    # comfyui_base_url 仅用于首次种子（v3.0 起图像配置以 ai_providers 表为准）
    "comfyui_base_url",
    "deepseek_base_url",
    "deepseek_model",
    "data_dir",
    "output_dir",
    "log_dir",
    "assets_root",
    "pipeline_min_score",
    "pipeline_collect_limit",
    "pipeline_publish_target",
    # 角色分配经 PUT /api/ai/roles 写入（唯一写入口，见 routers/ai.py）
    # Single-user desktop: API keys live in the local runtime.yaml.
    # They are never returned by GET — only set via PATCH.
    "deepseek_api_key",
    "llm_api_key",
}

SECRET_FIELDS = {"deepseek_api_key", "llm_api_key", "secret_key", "database_url"}


def _mask_secret(value: str) -> str | None:
    if not value:
        return None
    if len(value) <= 8:
        return "••••"
    return f"••••{value[-4:]}"


@router.get("")
async def get_config() -> dict:
    base = settings.model_dump()
    overrides = runtime_config.load()
    base.update(overrides)
    public = {k: v for k, v in base.items() if k not in SECRET_FIELDS and not k.startswith("_")}
    public["runtime_overrides"] = {k: v for k, v in overrides.items() if k in RUNTIME_ALLOWLIST}
    api_key = str(base.get("llm_api_key") or base.get("deepseek_api_key") or "")
    public["llm_api_key_masked"] = _mask_secret(api_key)
    public["llm_api_key_set"] = bool(api_key)
    return public


class ConfigUpdate(BaseModel):
    overrides: dict


@router.patch("")
async def update_config(req: ConfigUpdate) -> dict:
    disallowed = set(req.overrides) - RUNTIME_ALLOWLIST
    if disallowed:
        raise HTTPException(
            status_code=400, detail=f"Not runtime-configurable: {sorted(disallowed)}"
        )
    merged = runtime_config.load()
    merged.update(req.overrides)
    runtime_config.save(merged)
    return {"applied": {k: v for k, v in req.overrides.items()}}

