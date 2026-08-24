"""FastAPI router aggregation — thin layer: declares what exists, no logic."""

from fastapi import APIRouter

from backend.routers import (
    ai,
    brief_groups,
    briefs,
    buffs,
    canvas,
    channels,
    config,
    crews,
    deps,
    depths,
    docs,
    downloads,
    health,
    library,
    logs,
    metrics,
    phases,
    pipeline,
    plans,
    roles,
    studio,
)

api_router = APIRouter(prefix="/api")

api_router.include_router(health.router)
api_router.include_router(deps.router)
api_router.include_router(ai.router)
api_router.include_router(config.router)
api_router.include_router(downloads.router)
api_router.include_router(library.router)
api_router.include_router(crews.router)
api_router.include_router(buffs.router)
api_router.include_router(depths.router)
api_router.include_router(roles.router)
api_router.include_router(briefs.router)
api_router.include_router(brief_groups.router)
api_router.include_router(plans.router)
api_router.include_router(studio.router)
api_router.include_router(pipeline.router)
api_router.include_router(logs.router)
api_router.include_router(metrics.router)
api_router.include_router(docs.router)
api_router.include_router(canvas.router)
api_router.include_router(channels.router)
api_router.include_router(phases.router)
