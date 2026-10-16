"""E1 迁移漂移守卫（v0.37）：新库全量迁移后，模型元数据必须零结构漂移。

## 为什么需要它

测试库（``hertz_test``）schema 由 ``create_all`` 从**模型**重建，开发库走
alembic 迁移——两条建 schema 路径各有一套真相源。「模型加了列、迁移没加」
这类漂移在测试里**永远绿**，只在真实库上炸 ORM 的 INSERT（v0.36 实测：
``layout_revisions.updated_at`` 漏列，工坊保存/删除全 500）。

## 做法

临时起一个全新库 ``hertz_drift_guard``，``alembic upgrade heads`` 跑通全部
迁移，再用 autogenerate 比对模型元数据——断言不存在
add_table/remove_table/add_column/remove_column（唯一会在运行时炸 ORM 的
类别，口径见 ``backend/infrastructure/drift.py``；modify_nullable /
JSON→JSONB 等存量反映噪音不进断言）。

## 成对变异验证（本测试落地时实测过）

从 ``wave10_layout_data_safety`` 的建表 SQL 里删掉 ``created_at`` 列 →
本测试报 add_column 红；补回 → 绿。
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DRIFT_DB = "hertz_drift_guard"
DRIFT_URL = f"postgresql+asyncpg://hertz:hertz@localhost:5432/{DRIFT_DB}"
ADMIN_URL = "postgresql+asyncpg://hertz:hertz@localhost:5432/postgres"


def _admin_execute(sql: str) -> None:
    """在 postgres 管理库上执行一条建库/删库语句（自包含 engine，跨 asyncio.run 安全）。"""
    import asyncio

    import sqlalchemy as sa
    from sqlalchemy.ext.asyncio import create_async_engine

    async def _run() -> None:
        engine = create_async_engine(ADMIN_URL, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(sa.text(sql))
        finally:
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture(scope="module")
def fresh_migrated_db() -> str:
    """起一个全新库，跑通全部迁移，模块结束销毁。"""
    _admin_execute(f'DROP DATABASE IF EXISTS "{DRIFT_DB}"')
    _admin_execute(f'CREATE DATABASE "{DRIFT_DB}"')

    env = dict(os.environ, HERTZ_DATABASE_URL=DRIFT_URL)
    proc = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "heads"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, (
        f"新库全量迁移失败（E1 前提不成立）：\n"
        f"{proc.stdout[-2000:]}\n{proc.stderr[-2000:]}"
    )

    yield DRIFT_URL

    _admin_execute(f'DROP DATABASE IF EXISTS "{DRIFT_DB}"')


def test_migrations_match_model_schema(fresh_migrated_db: str) -> None:
    """新库全量迁移后，模型元数据零结构漂移（成对变异见模块 docstring）。"""
    import asyncio

    from backend.infrastructure.drift import compare_database

    report = asyncio.run(compare_database(fresh_migrated_db))
    assert report.ok, (
        "模型与迁移存在结构漂移——新库会缺列/缺表，ORM 在运行时炸：\n"
        + "\n".join(f"  - {line}" for line in report.structural)
    )
