"""运维域：任务历史/采集源/失败分类/排期/模板/Reddit cookie。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_ops.router 由 pipeline 聚合 include）。
"""

import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.factory.registry import ServiceRegistry

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline

@router.get("/reddit-cookie/status")
async def reddit_cookie_status() -> dict:
    """Cookie 状态（只报存在性/年龄/来源，绝不返回内容）。"""
    from backend.pipeline.reddit_cookies import cookies_status

    return cookies_status()


@router.post("/reddit-cookie/export")
async def reddit_cookie_export(force: bool = False) -> dict:
    """触发浏览器 cookie 自动导出（yt-dlp --cookies-from-browser）。"""
    from backend.pipeline.reddit_cookies import ensure_reddit_cookies

    return await ensure_reddit_cookies(force=force)


@router.get("/collect/status")
async def collect_status() -> dict:
    """采集运维状态（v0.8.2）：运行中/上次结果/下次自动/间隔。"""
    return await _pipe().collect_status()


class TemplateBody(BaseModel):
    name: str
    options: dict


class TemplateUpdate(BaseModel):
    name: str | None = None
    options: dict | None = None


def _templates():
    from backend.pipeline.templates import ProduceTemplateService

    return ProduceTemplateService()


@router.get("/produce-templates")
async def list_produce_templates() -> list[dict]:
    return await _templates().list_templates()


@router.post("/produce-templates")
async def create_produce_template(body: TemplateBody) -> dict:
    try:
        return await _templates().create(name=body.name, options=body.options)
    except Exception as exc:  # noqa: BLE001 — 模板名冲突等返回可读错误
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/produce-templates/{template_id}")
async def update_produce_template(template_id: uuid.UUID, body: TemplateUpdate) -> dict:
    try:
        fields = {k: v for k, v in body.model_dump().items() if v is not None}
        return await _templates().update(template_id, **fields)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/produce-templates/{template_id}")
async def delete_produce_template(template_id: uuid.UUID) -> dict:
    try:
        await _templates().delete(template_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True}


class PublishStatsBody(BaseModel):
    view: int = 0
    like: int = 0
    favorite: int = 0
    comment: int = 0
    share: int = 0


@router.post("/reschedule-expired")
async def reschedule_expired():
    """过期排期自动重排（v0.2.7）：进入审核时调用，逐个分配不冲突的新槽位。"""
    return {"updated": await _pipe().reschedule_expired()}


class ProduceOptionsBody(BaseModel):
    ids: list[uuid.UUID]
    options: dict[str, bool]


@router.get("/jobs")
async def recent_jobs(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    job_name: str = Query(""),
    status: str = Query(""),
):
    """任务历史（v0.8.7）：分页 + 类型/状态筛选；返回 {total, jobs}。"""
    return await _pipe().recent_jobs(
        limit=limit, offset=offset, job_name=job_name.strip(), status=status.strip()
    )


@router.get("/jobs/{job_id}")
async def job_detail(job_id: uuid.UUID):
    """单任务详情（v0.8.7）：活动面板展开用。"""
    return await _pipe().job_detail(job_id)


@router.get("/collect/history")
async def collect_history(limit: int = Query(10, ge=1, le=50)):
    """采集历史轮次（v0.8.7）：最近 N 轮逐源明细。"""
    return await _pipe().collect_history(limit)


@router.get("/sources")
async def sources():
    return await _pipe().sources()


@router.get("/supply")
async def supply_warnings():
    """供给告警（漏斗空 / 供给偏紧 / 采集源失联）。"""
    return {"warnings": await _pipe().supply_warnings()}


@router.get("/failures")
async def failure_classes():
    """failed 条目按失败分类聚合（v0.2.1 失败分类看板）。"""
    return await _pipe().failure_classes()


class RetryClassBody(BaseModel):
    cls: str

@router.post("/retry-class")
async def retry_failure_class(body: RetryClassBody):
    """同类批量重试：该失败分类的所有 failed 条目复位回可继续状态。"""
    try:
        count = await _pipe().retry_class(body.cls)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"cls": body.cls, "requeued": count}


@router.get("/schedule/next")
async def next_schedule_slot():
    """下一个发布槽位（本地排期引擎）：窗口内 + 最小间隔 + 抖动。"""
    return {"recommended_at": await _pipe().next_schedule_slot()}


@router.post("/auto-approve")
async def auto_approve():
    """手动触发自动过审（配置 pipeline_auto_approve 开启才生效）。"""
    return await _pipe().auto_approve()


