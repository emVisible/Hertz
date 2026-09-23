"""固化后端启动入口（v0.21 P0 安装即用，PyInstaller 打包目标）。

职责顺序：
1. 确保数据库存在——内嵌 PG 走 zonky 发行包（不含 createdb），用 asyncpg 兜底建库
2. alembic 升级到 head（打包态从 _MEIPASS 解析 ini/脚本目录）
3. uvicorn 拉起 backend.main:app（端口读 HERTZ_BACKEND_PORT，与 Electron 同源）

dev 态不走此文件：scripts/dev.sh 的 uvicorn 命令行 + 手动 alembic 等价。
"""

import asyncio
import sys
from pathlib import Path


def _base_dir() -> Path:
    """alembic.ini 所在目录：frozen 态在解包根，源码态在仓库根。"""
    if getattr(sys, "frozen", False):
        return Path(sys._MEIPASS)  # noqa: SLF001 — PyInstaller 约定
    return Path(__file__).resolve().parent.parent


def _ensure_database() -> None:
    """目标库不存在时创建（幂等；连接参数全部来自 settings.database_url）。"""
    import asyncpg
    from sqlalchemy.engine import make_url

    from backend.config import settings

    url = make_url(settings.database_url)
    dbname = url.database or "hertz"

    async def _create() -> bool:
        # 关键字参数直连：此前手拼 DSN 只填了 user/host/port，**丢掉了口令**——
        # 内嵌 PG 是 trust 认证所以打包版无感，但 main.ts 明文推荐的
        # 「设 HERTZ_DATABASE_URL 指向外部 PostgreSQL」逃生通道会在迁移之前
        # 就 InvalidPasswordError 死掉（哪怕目标库已存在）。
        # 走 kwargs 也顺带回避了口令里特殊字符的 URL 转义问题。
        conn = await asyncpg.connect(
            host=url.host or "localhost",
            port=int(url.port or 5432),
            user=url.username or "postgres",
            password=url.password,
            database="postgres",
            timeout=10,
        )
        try:
            exists = await conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = $1", dbname
            )
            if not exists:
                # 标识符不能参数化；库名来自受控配置（默认 hertz）
                await conn.execute(f'CREATE DATABASE "{dbname}"')  # noqa: S608
            return not exists
        finally:
            await conn.close()

    created = asyncio.run(_create())
    print(f"[entrypoint] database '{dbname}' {'created' if created else 'exists'}")


def _migrate() -> None:
    """alembic upgrade heads（编程式；URL 由 env.py 从 settings 解析）。

    用复数 `heads` 而非 `head`：仓库现状为多 head（wave26_item_priority 主线 +
    wave21_glossary_remove 悬空分支），单数 `head` 在 alembic 侧直接抛
    CommandError「Multiple head revisions are present」——新库首启即崩（v0.30
    打包验证暴露）。dev 库存量已同时 stamp 两个 head，upgrade heads 与之对齐。
    """
    from alembic.config import Config

    from alembic import command

    base = _base_dir()
    cfg = Config(str(base / "alembic.ini"))
    cfg.set_main_option("script_location", str(base / "alembic"))
    command.upgrade(cfg, "heads")
    print("[entrypoint] migrations at heads")


def main() -> None:
    import time

    from backend.config import settings

    t0 = time.perf_counter()
    _ensure_database()
    t1 = time.perf_counter()
    print(f"[startup-timing] ensure_database {t1 - t0:.2f}s")
    _migrate()
    t2 = time.perf_counter()
    print(f"[startup-timing] migrations {t2 - t1:.2f}s")

    import uvicorn

    from backend.main import app

    uvicorn.run(app, host="127.0.0.1", port=settings.backend_port, log_level="info")


if __name__ == "__main__":
    main()
