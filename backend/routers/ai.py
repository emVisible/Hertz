"""AI endpoints: capability status, provider smoke tests, v2.0 底座管理.

底座管理（Provider/模型/角色/调用链）挂 /ai 下：
- GET  /ai/providers          Provider 列表（不含明文 key）
- POST /ai/providers          新建 Provider（模板或自定义）
- GET  /ai/providers/{id}     详情（含明文 key 仅此处返回）
- PUT  /ai/providers/{id}     更新（key/base_url/启用）
- DELETE /ai/providers/{id}   删除
- GET  /ai/models             模型列表
- POST /ai/models             添加模型
- PUT/DELETE /ai/models/{id}
- POST /ai/providers/{id}/fetch-models   拉取 /v1/models
- POST /ai/providers/{id}/test           连通性测试
- GET  /ai/roles              角色分配（main/fast/...）
- PUT  /ai/roles              保存角色分配
- GET  /ai/trace              调用链（?task_id= / ?limit=）
- GET  /ai/templates          Provider 模板库
"""

import uuid

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.factory.registry import ServiceRegistry
from backend.models.ai_registry import ModelCapability
from backend.routers.schemas import MAX_NAME

router = APIRouter(prefix="/ai", tags=["ai"])

_CAPABILITIES = {c.value for c in ModelCapability}


class ChatTestRequest(BaseModel):
    message: str = Field(default="用一句话介绍你自己", max_length=500)


class ScoreRequest(BaseModel):
    title: str = Field(max_length=255)
    content: str = Field(max_length=5000)
    source: str = Field(default="", max_length=128)


class ImageTestRequest(BaseModel):
    prompt: str = Field(max_length=1000)
    negative_prompt: str = Field(default="", max_length=1000)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: int = Field(default=20, ge=1, le=60)


class TTSRequest(BaseModel):
    text: str = Field(max_length=500)
    voice: str = Field(default="zh-CN-XiaoxiaoNeural")


# ---------- v2.0 底座管理 ----------




class ProviderCreate(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    template: str = Field(default="custom", max_length=64)
    base_url: str = Field(default="", max_length=255)
    api_keys: list[str] = Field(default_factory=list, max_length=16)


class ProviderUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    base_url: str | None = Field(default=None, max_length=255)
    api_keys: list[str] | None = Field(default=None, max_length=16)
    enabled: bool | None = None


class ModelCreate(BaseModel):
    provider_id: uuid.UUID
    key: str = Field(min_length=1, max_length=120)
    name: str = Field(default="", max_length=120)
    capability: str = Field(default="chat", max_length=32)
    context_window: int | None = Field(default=None, ge=0, le=16_000_000)


class ModelUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    capability: str | None = Field(default=None, max_length=32)
    enabled: bool | None = None


class RolesUpdate(BaseModel):
    roles: dict[str, str]  # {role: "provider:model"}


def _registry():
    return ServiceRegistry.get().providers


@router.get("/templates")
async def list_templates() -> dict:
    from backend.ai.templates import PROVIDER_TEMPLATES

    return {
        "templates": [
            {
                "key": t.key,
                "name": t.name,
                "base_url": t.base_url,
                "desc": t.desc,
                "needs_key": t.needs_key,
                "protocol": t.protocol,
                "models": [list(m) for m in t.models],
            }
            for t in PROVIDER_TEMPLATES
        ]
    }


@router.get("/providers")
async def list_providers() -> list[dict]:
    return await _registry().list_providers()


@router.post("/providers")
async def create_provider(body: ProviderCreate) -> dict:
    if any(len(k) > 512 for k in body.api_keys):
        raise HTTPException(status_code=422, detail="api key too long")
    try:
        return await _registry().create_provider(
            name=body.name, template=body.template,
            base_url=body.base_url, api_keys=body.api_keys,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/providers/{provider_id}")
async def get_provider(provider_id: uuid.UUID) -> dict:
    try:
        return await _registry().get_provider(provider_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/providers/{provider_id}")
async def update_provider(provider_id: uuid.UUID, body: ProviderUpdate) -> dict:
    if body.api_keys and any(len(k) > 512 for k in body.api_keys):
        raise HTTPException(status_code=422, detail="api key too long")
    try:
        return await _registry().update_provider(
            provider_id,
            name=body.name, base_url=body.base_url,
            api_keys=body.api_keys, enabled=body.enabled,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: uuid.UUID) -> dict:
    try:
        await _registry().delete_provider(provider_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/providers/{provider_id}/fetch-models")
async def fetch_models(provider_id: uuid.UUID) -> list[dict]:
    try:
        return await _registry().fetch_models(provider_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — 远端拉取失败返回可读错误
        raise HTTPException(status_code=502, detail=f"获取模型列表失败：{exc}") from exc


@router.post("/providers/{provider_id}/test")
async def test_provider(provider_id: uuid.UUID, body: dict | None = None) -> dict:
    model_key = (body or {}).get("model_key")
    try:
        return await _registry().test_provider(provider_id, model_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/models")
async def list_models(provider_id: uuid.UUID | None = None) -> list[dict]:
    return await _registry().list_models(provider_id)


@router.post("/models")
async def create_model(body: ModelCreate) -> dict:
    if body.capability not in _CAPABILITIES:
        raise HTTPException(status_code=422, detail=f"invalid capability: {body.capability}")
    try:
        return await _registry().add_model(
            provider_id=body.provider_id,
            key=body.key, name=body.name,
            capability=body.capability, context_window=body.context_window,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/models/{model_id}")
async def update_model(model_id: uuid.UUID, body: ModelUpdate) -> dict:
    if body.capability is not None and body.capability not in _CAPABILITIES:
        raise HTTPException(status_code=422, detail=f"invalid capability: {body.capability}")
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _registry().update_model(model_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/models/{model_id}")
async def delete_model(model_id: uuid.UUID) -> dict:
    try:
        await _registry().delete_model(model_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.get("/roles")
async def get_roles() -> dict:
    from backend.config import settings

    return {"roles": settings.ai_roles or {}}


_ROLE_KEYS = {"main", "fast", "image", "tts", "embedding"}


@router.put("/roles")
async def save_roles(body: RolesUpdate) -> dict:
    """保存角色分配（provider:model）。写入 runtime.yaml（用户可改配置）。"""
    from backend.config import runtime_config

    # 校验角色 key 与 provider:model 格式（AXIOM §8.1 快速失败）
    cleaned: dict[str, str] = {}
    for key, value in body.roles.items():
        if not value:
            continue
        if key not in _ROLE_KEYS:
            raise HTTPException(status_code=422, detail=f"unknown role: {key}")
        if ":" not in value or len(value) > 255:
            raise HTTPException(status_code=422, detail=f"invalid role value for {key}: {value}")
        cleaned[key] = value
    data = runtime_config.load()
    data["ai_roles"] = cleaned
    runtime_config.save(data)
    return {"roles": cleaned}


@router.get("/trace")
async def trace(task_id: str | None = None, limit: int = 50) -> list[dict]:
    from backend.ai.tracing import list_calls

    return await list_calls(task_id, limit)


# ---------- v2.4 提示词模板库 ----------


class TemplateUpdate(BaseModel):
    content: str = Field(min_length=1, max_length=50_000)


@router.get("/prompts")
async def list_prompts() -> list[dict]:
    from backend.ai.prompts.template_service import prompt_templates

    return await prompt_templates.list()


@router.put("/prompts/{key}")
async def update_prompt(key: str, body: TemplateUpdate) -> dict:
    from backend.ai.prompts.template_service import prompt_templates

    try:
        return await prompt_templates.update(key, body.content)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/prompts/{key}/reset")
async def reset_prompt(key: str) -> dict:
    from backend.ai.prompts.template_service import prompt_templates

    try:
        return await prompt_templates.reset(key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ---------- 既有测试端点（保留） ----------


@router.get("/status")
async def ai_status() -> dict:
    ai = ServiceRegistry.get().ai
    return {"status": ai.status() if ai else {"llm": False, "image": False, "tts": False}}


@router.post("/llm/test")
async def llm_test(req: ChatTestRequest) -> dict:
    ai = ServiceRegistry.get().ai
    if ai is None or not ai.llm_available:
        raise HTTPException(status_code=503, detail="LLM provider not configured")
    reply = await ai.chat(req.message)
    return {"reply": reply}


@router.post("/score")
async def score(req: ScoreRequest) -> dict:
    ai = ServiceRegistry.get().ai
    if ai is None or not ai.llm_available:
        raise HTTPException(status_code=503, detail="LLM provider not configured")
    result = await ai.score(title=req.title, content=req.content, source=req.source)
    return {
        "total": result.total,
        "dimensions": result.dimensions,
        "reasons": result.reasons,
        "fallback": result.fallback,
    }


@router.post("/image/test")
async def image_test(req: ImageTestRequest) -> dict:
    ai = ServiceRegistry.get().ai
    if ai is None or not ai.image_available:
        raise HTTPException(status_code=503, detail="Image provider not configured")
    result = await ai.generate_image(
        req.prompt,
        negative_prompt=req.negative_prompt,
        width=req.width,
        height=req.height,
        steps=req.steps,
    )
    return {
        "path": str(result.path),
        "width": result.width,
        "height": result.height,
        "seed": result.seed,
    }


@router.post("/tts/test")
async def tts_test(req: TTSRequest) -> Response:
    ai = ServiceRegistry.get().ai
    if ai is None or not ai.tts_available:
        raise HTTPException(status_code=503, detail="TTS provider not configured")
    audio = await ai.synthesize(req.text, req.voice)
    return Response(content=audio, media_type="audio/mpeg")
