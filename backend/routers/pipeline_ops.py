"""运维域：任务历史/采集源/失败分类/排期/模板/Reddit cookie。

v0.8.9 AXIOM 2.1 路由域拆分：原 pipeline.py 30+ 端点 7 域挤一文件，
按用户可感知域拆出；路径与语义不变（pipeline_ops.router 由 pipeline 聚合 include）。
"""

import logging
import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.factory.registry import ServiceRegistry

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pipeline", tags=["pipeline"])


def _pipe():
    return ServiceRegistry.get().pipeline

@router.get("/reddit-cookie/status")
async def reddit_cookie_status() -> dict:
    """Cookie 状态（只报存在性/年龄/来源，绝不返回内容）。"""
    from backend.pipeline.reddit_cookies import cookies_status

    return cookies_status()


@router.post("/reddit-cookie/export")
async def reddit_cookie_export(
    force: bool = False,
    browser: str = "",
    verify: bool = False,
) -> dict:
    """触发浏览器 cookie 自动导出（yt-dlp --cookies-from-browser）。

    v0.11.7：支持指定浏览器；verify=true 时导出后立即试 Reddit 通道
    （hot.json），返回 verify_status——避免「导出成功但 cookie 无效」。
    """
    from backend.pipeline.reddit_cookies import (
        _has_session_cookie,
        cookie_header_for_http,
        ensure_reddit_cookies,
    )

    result = await ensure_reddit_cookies(force=force, browser=browser)
    if result.get("ok"):
        header = cookie_header_for_http()
        result["session_cookie"] = _has_session_cookie(header)
        if verify:
            result["verify_status"] = await _verify_reddit_channel(header)
    return result


async def _verify_reddit_channel(cookie: str | None) -> dict:
    """带 cookie 试 Reddit JSON 通道（hot.json limit=1），只报状态不报内容。"""
    import httpx

    from backend.pipeline.collectors.reddit import _UA, _system_proxy

    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": _UA, "Cookie": cookie or ""},
            timeout=20,
            proxy=_system_proxy(),
        ) as client:
            resp = await client.get(
                "https://www.reddit.com/r/AmItheAsshole/hot.json",
                params={"limit": 1, "raw_json": 1},
            )
            return {"code": resp.status_code, "ok": resp.status_code == 200}
    except httpx.HTTPError as exc:
        return {"ok": False, "error": exc.__class__.__name__}


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




def _spawn_model_download(task_name: str, ensure_model) -> dict:
    """后台触发模型下载（fire-and-forget）+ telemetry tick（成败均记）。

    100MB 级下载不能挂在 HTTP 请求上：前端轮询对应的 /status 直到 model_ready。
    `ensure_model` 幂等（就绪即返回，不碰网络），所以按钮重复点也无害。
    """
    import asyncio

    from backend.infrastructure.telemetry import record_tick

    async def _job() -> None:
        t0 = asyncio.get_running_loop().time()
        ok = (await ensure_model(force=False)) is not None
        ms = int((asyncio.get_running_loop().time() - t0) * 1000)
        record_tick(task_name, ok, ms, "" if ok else "download failed")
        if ok:
            # 能力矩阵与制作前预检都读这份缓存；不刷新的话「刚下好」要等到下次
            # 重启/手动重测才算数——同一次操作的两半互相看不见
            from backend.infrastructure.deps import refresh_dependencies

            try:
                await refresh_dependencies()
            except Exception as exc:  # noqa: BLE001 — 刷新失败不影响已下好的模型
                logger.info("deps refresh after %s failed: %s", task_name, exc)

    asyncio.create_task(_job())
    return {"started": True}


@router.get("/integrity")
async def integrity_report() -> dict:
    """数据体检报告（v0.33）：库里数据与判据是否一致，只报不改。

    默认由 `integrity` 定时任务跑；这里给手动入口（设置页/我自己核验都用它）。
    """
    from backend.pipeline.integrity import integrity_report as build_report

    return await build_report()


@router.get("/translate-model/status")
async def translate_model_status() -> dict:
    """本地翻译引擎就绪状态（依赖 + 模型文件）。

    就绪判定读 `infrastructure/paths`（能力矩阵同一份），不在这里重数一遍文件名。
    """
    from backend.infrastructure import paths
    from backend.pipeline.producers import translate_engine

    return {
        "deps": translate_engine.deps_available(),
        "model_ready": paths.local_mt_ready(),
    }


@router.post("/translate-model/download")
async def translate_model_download() -> dict:
    """后台触发本地翻译模型下载（幂等：已就绪直接返回）。"""
    from backend.pipeline.producers import translate_engine

    return _spawn_model_download(
        "translate_model_download", translate_engine.ensure_model
    )


@router.get("/whisper-model/status")
async def whisper_model_status() -> dict:
    """本地转写（faster-whisper）就绪状态：依赖可导入 + 配置档位已在 data_dir 下。

    `xinference_on` 一并回给前端：配了 STT 服务时本地模型并非必经之路，
    卡片要说「服务优先」而不是把服务态判成缺模型。
    """
    from backend.infrastructure import deps, paths
    from backend.pipeline.producers import asr

    name = asr.whisper_model_name()
    return {
        "deps": deps.whisper_importable(),
        "model_ready": paths.whisper_model_ready(name),
        "model_name": name,
        "dir": str(paths.whisper_model_dir(name)),
        "xinference_on": asr.xinference_configured(),
    }


@router.post("/whisper-model/download")
async def whisper_model_download() -> dict:
    """后台触发当前档位转写模型下载（幂等；切档位后需重新点一次）。"""
    from backend.pipeline.producers import asr

    return _spawn_model_download("whisper_model_download", asr.ensure_model)
