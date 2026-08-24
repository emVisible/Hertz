"""DB 定时备份（v0.22 可见性补全）：pg_dump → data/backups 滚动保留。

- 仅 PostgreSQL：解析 settings.database_url 取凭据（与运行库同源）
- 自定义格式 -Fc（支持 pg_restore 单表恢复），体积远小于纯 SQL
- 滚动保留 backup_keep 份；pg_dump 不在 PATH 时记录失败（deps 引导安装）
"""

import asyncio
import logging
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.engine import make_url

from backend.config import settings

logger = logging.getLogger(__name__)


def backups_dir() -> Path:
    return Path(settings.data_dir) / "backups"


async def run_backup(keep: int | None = None) -> dict:
    """执行一次 pg_dump 并滚动清理；返回结果摘要（供 metrics/告警）。"""
    t0 = asyncio.get_running_loop().time()
    url = make_url(settings.database_url)
    if not url.get_backend_name().startswith("postgresql"):
        return {"ok": False, "reason": f"unsupported backend: {url.get_backend_name()}"}

    keep_n = int(keep if keep is not None else getattr(settings, "backup_keep", 7) or 7)
    out_dir = backups_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    out = out_dir / f"hertz-{stamp}.dump"

    cmd = [
        "pg_dump",
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        f"--host={url.host or 'localhost'}",
        f"--port={url.port or 5432}",
        f"--username={url.username or 'postgres'}",
        "--file", str(out),
        url.database or "hertz",
    ]
    env_pass = str(url.password or "")
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={**__import__("os").environ, "PGPASSWORD": env_pass},
    )
    try:
        _, err = await asyncio.wait_for(proc.communicate(), timeout=600)
    except TimeoutError:
        proc.kill()
        return {"ok": False, "reason": "pg_dump timeout (600s)"}
    if proc.returncode != 0:
        reason = (err.decode(errors="replace") or "").strip()[-300:]
        logger.warning("backup failed: %s", reason)
        return {"ok": False, "reason": reason}

    # 滚动保留最近 keep_n 份
    dumps = sorted(out_dir.glob("hertz-*.dump"))
    removed = 0
    for old in dumps[:-keep_n] if keep_n > 0 else dumps:
        await asyncio.to_thread(old.unlink, missing_ok=True)
        removed += 1

    duration_ms = int((asyncio.get_running_loop().time() - t0) * 1000)
    size = out.stat().st_size if await asyncio.to_thread(out.exists) else 0
    logger.info("backup ok: %s (%d bytes, %dms, pruned %d)", out.name, size, duration_ms, removed)
    return {
        "ok": True,
        "file": str(out),
        "size": size,
        "duration_ms": duration_ms,
        "pruned": removed,
    }


def last_backup_info() -> dict:
    """最近一份备份信息（metrics 展示；无备份返回 null 语义字段）。"""
    out_dir = backups_dir()
    dumps = sorted(out_dir.glob("hertz-*.dump"))
    if not dumps:
        return {"exists": False}
    latest = dumps[-1]
    return {
        "exists": True,
        "file": latest.name,
        "size": latest.stat().st_size,
        "at": datetime.fromtimestamp(latest.stat().st_mtime, UTC).isoformat(),
    }
