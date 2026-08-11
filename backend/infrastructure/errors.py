"""Global exception handlers: machine-readable JSON for every failure path."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.errors import HertzError

log = logging.getLogger("hertz.http")

# 领域错误 code → HTTP 状态（v0.8：路由层不再逐端点 try/except 包装）
_CODE_STATUS = {
    "item_not_found": 404,
    "invalid_item_state": 409,
    "not_found": 404,
    "already_running": 409,
    "invalid_plan": 422,
}


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(HertzError)
    async def hertz_error_handler(_: Request, exc: HertzError) -> JSONResponse:
        return JSONResponse(
            status_code=_CODE_STATUS.get(exc.code, 400),
            content={"detail": exc.message, "code": exc.code},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": "validation error", "errors": exc.errors()},
        )

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    @app.exception_handler(Exception)
    async def unhandled_handler(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled exception: %s", exc)
        return JSONResponse(status_code=500, content={"detail": "internal server error"})
