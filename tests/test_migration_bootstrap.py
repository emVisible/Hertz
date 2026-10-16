"""固化/开发启动器的迁移引导守卫（v0.30.1 / D-199）。

覆盖两类曾真实发生的故障：
1. 多 head 现状下 `alembic upgrade head`（单数）直接抛 CommandError——
   entrypoint 版只在**全新数据库首启**才暴露（dev 库早已 stamp 双 head，
   开发机永不复现，见 D-198），dev.sh 版则让新克隆仓库的人冷启动即挂。
2. `_ensure_database()` 手拼 DSN 时丢掉口令——内嵌 PG 是 trust 认证所以
   打包版无感，但 main.ts 明文推荐的「外部 PostgreSQL」逃生通道必死。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


# ---------- 多 head：所有升级入口必须用复数 spec ----------

def test_bootstrap_scripts_use_plural_heads() -> None:
    """不变量是「入口用复数 heads」，不是「恰好有 N 个 head」。

    断言 head 数量会把临时状态固化成不变量，下次正常新增迁移就自炸；
    复数 spec 对 1 个或 5 个 head 都成立。"""
    dev_sh = (ROOT / "scripts" / "dev.sh").read_text(encoding="utf-8")
    entrypoint = (ROOT / "backend" / "entrypoint.py").read_text(encoding="utf-8")

    for name, text in (("scripts/dev.sh", dev_sh), ("backend/entrypoint.py", entrypoint)):
        assert not re.search(r"upgrade\s+head(?!s)", text), f"{name} 仍在使用单数 head"

    assert re.search(r"alembic upgrade heads\b", dev_sh), "dev.sh 未走 heads"


def test_entrypoint_migrate_passes_heads(monkeypatch) -> None:
    """行为守卫：真的把 "heads" 传给 alembic（文本扫描挡不住重构改写法）。"""
    import alembic.command as alembic_command

    import backend.entrypoint as entrypoint

    recorded: list[str] = []
    monkeypatch.setattr(
        alembic_command, "upgrade", lambda cfg, revision: recorded.append(revision)
    )
    entrypoint._migrate()  # noqa: SLF001 — 守卫的就是这个私有引导步骤
    assert recorded == ["heads"], recorded


def test_migration_graph_parses() -> None:
    """alembic 脚本目录必须可解析（无悬空 down_revision）。不查数量。"""
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    heads = ScriptDirectory.from_config(cfg).get_heads()
    assert heads, "迁移图解析不出 head——脚本目录或 down_revision 已损坏"


def test_revision_ids_fit_alembic_version_column() -> None:
    """revision id 不得超 32 字符：alembic 自建的 alembic_version.version_num 是 VARCHAR(32)。

    id 超长会在迁移事务的最后一步 UPDATE version_num 时
    StringDataRightTruncation——整条迁移连同它的 alter 一起回滚，
    而错误信息指向 version_num、看不出真正想做的事（wave34 实测踩过）。
    """
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    script = ScriptDirectory.from_config(cfg)
    too_long = [rev.revision for rev in script.walk_revisions() if len(rev.revision) > 32]
    assert not too_long, f"revision id 超 32 字符（alembic_version.version_num 上限）: {too_long}"


# ---------- 外部库口令透传 ----------

class _FakeConn:
    def __init__(self) -> None:
        self.closed = False

    async def fetchval(self, _sql, *_args):
        return None  # 目标库「不存在」→ 走 CREATE DATABASE 分支

    async def execute(self, _sql):
        return None

    async def close(self):
        self.closed = True


def _capture_connect(monkeypatch, kwargs_box: list) -> None:
    import asyncpg

    async def _fake_connect(*args, **kwargs):
        kwargs_box.append({"args": args, "kwargs": kwargs})
        return _FakeConn()

    monkeypatch.setattr(asyncpg, "connect", _fake_connect)


def test_ensure_database_forwards_password(monkeypatch) -> None:
    """外部 PostgreSQL（有口令）——main.ts 明确推荐的逃生通道。"""
    import backend.config as config
    import backend.entrypoint as entrypoint

    monkeypatch.setattr(
        config.settings,
        "database_url",
        "postgresql+asyncpg://alice:s3cr%2Ft@db.example:5433/hertz",
    )
    box: list = []
    _capture_connect(monkeypatch, box)

    entrypoint._ensure_database()  # noqa: SLF001

    assert box, "未发起连接"
    kwargs = box[0]["kwargs"]
    # URL 里的 %2F 被 make_url 解成真实口令——asyncpg 要的是原始口令而非转义串。
    # 这正是手拼 DSN 会踩的转义坑：走 kwargs 后口令原样送达。
    assert kwargs.get("password") == "s3cr/t", f"口令被丢弃/转义错误: {kwargs}"
    assert kwargs.get("host") == "db.example"
    assert kwargs.get("port") == 5433
    assert kwargs.get("user") == "alice"
    assert kwargs.get("database") == "postgres"  # 连管理库建目标库


def test_ensure_database_still_works_without_password(monkeypatch) -> None:
    """内嵌 PG 的 trust 路径零变化（password=None 照旧可连）。"""
    import backend.config as config
    import backend.entrypoint as entrypoint

    monkeypatch.setattr(
        config.settings, "database_url", "postgresql+asyncpg://hertz@127.0.0.1:54788/hertz"
    )
    box: list = []
    _capture_connect(monkeypatch, box)

    entrypoint._ensure_database()  # noqa: SLF001

    kwargs = box[0]["kwargs"]
    assert kwargs.get("password") is None
    assert kwargs.get("host") == "127.0.0.1"
    assert kwargs.get("port") == 54788
