"""Phase catalog endpoints: 工序库 CRUD（内置只读，自定义可增删改）。"""


from fastapi import APIRouter, HTTPException

from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/phases", tags=["phases"])


def _service():
    return ServiceRegistry.get().phases


@router.get("")
async def list_phases():
    return await _service().list()


@router.post("")
async def create_phase(body: dict):
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    try:
        return await _service().create(
            name,
            str(body.get("description") or ""),
            method=str(body.get("method") or ""),
            style=body.get("style"),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{phase_key}")
async def update_phase(phase_key: str, body: dict):
    try:
        return await _service().update(
            phase_key,
            name=body.get("name"),
            description=body.get("description"),
            role=body.get("role"),
            method=body.get("method"),
            style=body.get("style"),
            model=body.get("model"),
            retries=body.get("retries"),
            timeout_s=body.get("timeout"),
            reference=body.get("reference"),
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{phase_key}")
async def delete_phase(phase_key: str):
    try:
        await _service().delete(phase_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


@router.post("/restore-defaults")
async def restore_defaults():
    """一键恢复默认工序库（内置复位 + 清除自定义）。"""
    return {"restored": await _service().restore_defaults()}
