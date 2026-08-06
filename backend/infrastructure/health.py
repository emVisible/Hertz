"""Health checks: layered, structured, scriptable (AXIOM §28)."""

import importlib.util
import shutil
from dataclasses import dataclass, field

from sqlalchemy import text

from backend.config import settings
from backend.database import engine


@dataclass
class HealthReport:
    status: str = "ok"
    checks: dict[str, dict] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"status": self.status, "checks": self.checks}


async def check_database() -> dict:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return {"status": "ok"}
    except Exception as exc:  # noqa: BLE001 — health checks report, never raise
        return {"status": "error", "detail": str(exc)}


async def check_tools() -> dict:
    """System tools: ffmpeg / ffprobe binaries and the yt-dlp module."""
    tools: dict[str, dict] = {}
    for name in ("ffmpeg", "ffprobe"):
        path = shutil.which(name)
        if path:
            tools[name] = {"status": "ok", "path": path}
        else:
            tools[name] = {"status": "error", "detail": "not found in PATH"}
    ytdlp = importlib.util.find_spec("yt_dlp")
    if ytdlp:
        tools["yt-dlp"] = {"status": "ok", "path": ytdlp.origin}
    else:
        tools["yt-dlp"] = {"status": "error", "detail": "module not installed"}
    if any(t["status"] == "error" for t in tools.values()):
        return {"status": "warning", "tools": tools}
    return {"status": "ok", "tools": tools}


async def check_disk(min_free_gb: float = 5.0) -> dict:
    """Disk space on the data directory; below threshold degrades to warning."""
    try:
        usage = shutil.disk_usage(settings.data_dir)
        free_gb = usage.free / (1024**3)
        total_gb = usage.total / (1024**3)
        status = "warning" if free_gb < min_free_gb else "ok"
        return {"status": status, "free_gb": round(free_gb, 2), "total_gb": round(total_gb, 2)}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "detail": str(exc)}


async def check_provider(name: str, call: callable) -> dict:  # noqa: ARG005
    try:
        result = await call()
        return {"status": "ok", **result}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "detail": str(exc)}


async def run_health_checks(extra: dict[str, callable] | None = None) -> HealthReport:
    report = HealthReport()
    report.checks["database"] = await check_database()
    report.checks["tools"] = await check_tools()
    report.checks["disk"] = await check_disk()
    for name, call in (extra or {}).items():
        report.checks[name] = await check_provider(name, call)
    if any(c["status"] == "error" for c in report.checks.values()):
        report.status = "degraded"
    elif any(c["status"] == "warning" for c in report.checks.values()):
        report.status = "ok"
    return report
