"""Pipeline endpoints — 聚合文件（v0.8.9 AXIOM 2.1 路由域拆分）。

原 40+ 端点 7 域挤一文件，按用户可感知域拆为四个子 router：
- pipeline_run：运行控制（status/steps/run/chain/cancel/SSE 事件流）
- pipeline_items：条目域（列表/审核/预处理/meta/封面/日历/趋势）
- pipeline_publish：发布域（publish/publish-status/数据回捞）
- pipeline_ops：运维域（任务历史/采集源/失败分类/排期/模板/Reddit cookie）

本文件只做 include——路径与语义不变（AXIOM 38：前缀单点定义）。
"""

from fastapi import APIRouter

from backend.routers.pipeline_items import router as _items
from backend.routers.pipeline_ops import router as _ops
from backend.routers.pipeline_publish import router as _publish
from backend.routers.pipeline_run import router as _run

router = APIRouter()
router.include_router(_run)
router.include_router(_items)
router.include_router(_publish)
router.include_router(_ops)
