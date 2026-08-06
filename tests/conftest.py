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
