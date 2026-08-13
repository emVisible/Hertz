"""Shared pytest fixtures: async app client against a dedicated test database.

Tests run against ``hertz_test`` (created on demand, schema rebuilt every
session) so the development database is never polluted and leftover rows
from a previous run cannot leak into assertions.
"""

import asyncio
import os

# Must happen before any `backend.*` import: the engine binds to the URL
# present in the environment at import time.
os.environ.setdefault(
    "HERTZ_DATABASE_URL", "postgresql+asyncpg://hertz:hertz@localhost:5432/hertz_test"
)

# 测试数据根隔离（v0.8.8，AXIOM 34）：必须与数据库同批注入——
# FileStore/LogManager 在 import 期锚定 settings.data_dir，若指向真实 data/，
# 测试会改写 deps.json/hertz.log 甚至覆盖真实成片（final.mp4 被测试条目覆盖过）
import tempfile  # noqa: E402

os.environ.setdefault(
    "HERTZ_DATA_DIR", os.path.join(tempfile.mkdtemp(prefix="hertz-test-data-"), "data")
)

# Pipeline download step: allow loopback test servers (SSRF guard is
# on by default; tests opt out explicitly — AXIOM §8.1).
os.environ.setdefault("HERTZ_PIPELINE_ALLOW_LOOPBACK_URLS", "1")

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from backend.main import app  # noqa: E402


def _prepare_database() -> None:
    """Create the test database if missing and rebuild the schema."""
    import sqlalchemy as sa
    from sqlalchemy.ext.asyncio import create_async_engine

    admin = create_async_engine(
        "postgresql+asyncpg://hertz:hertz@localhost:5432/postgres", isolation_level="AUTOCOMMIT"
    )

    async def _run() -> None:
        try:
            async with admin.connect() as conn:
                exists = await conn.scalar(
                    sa.text("SELECT 1 FROM pg_database WHERE datname = 'hertz_test'")
                )
                if not exists:
                    await conn.execute(sa.text("CREATE DATABASE hertz_test"))

            import backend.models  # noqa: F401 — register every table on Base.metadata
            from backend.database import engine
            from backend.models.base import Base

            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
                await conn.run_sync(Base.metadata.create_all)
        finally:
            await admin.dispose()
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture(scope="session", autouse=True)
def _test_database():
    _prepare_database()
    yield


@pytest.fixture
async def client() -> AsyncClient:
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest.fixture(autouse=True)
async def _dispose_engine():
    """Drop pooled asyncpg connections after every test.

    Each test runs in a fresh event loop; the module-level engine must not
    carry loop-bound connections across tests (asyncpg raises "attached to
    a different loop" otherwise).
    """
    yield
    from backend.database import engine

    await engine.dispose()


@pytest.fixture(autouse=True)
def _reset_pipeline_state():
    """v0.10.1 异步队列：后台任务跨测试泄漏防护。

    run_batch 现在 create_task 后台执行——前一个测试结束时任务随旧 loop
    被取消（CancelledError → FAILED job 落库），残留 _task/_current_job
    会污染下一个测试（409 busy / jobs 出现 failed）。每个测试开始前重置
    单例状态；旧 loop 的 task 不可 cancel（loop 已关），直接丢引用。
    """
    from backend.factory.registry import ServiceRegistry

    yield
    pipe = ServiceRegistry.get().pipeline
    pipe._task = None
    pipe._current_job = None
