"""Log endpoints: recent buffered lines + persistent file history.

v0.8.7 企业级对齐（Grafana/Loki 模式）：系统日志历史读 hertz.log + 轮转文件
（已持久化，AXIOM §17.11 不重复存储）——支持级别筛选 / 关键字 / 时间游标
向前翻页。v0.8.9：/logs/buffer 死端点已删除（前端零调用，AXIOM 46）；
内存 buffer 仍作为 /logs 的异常回退路径保留。
v0.8.8 查漏补缺（AXIOM 审计）：message 密钥脱敏（§8.2）、文件 mtime 缓存
（§7.2 交互预算——轮询不再重复扫描全文件）、since/until 格式校验与 q 截断（§8.1）。
"""

import re
from pathlib import Path

from fastapi import APIRouter, Query

from backend.infrastructure.logging import log_manager

router = APIRouter(tags=["logs"])

# fmt_detail: "%(asctime)s %(levelname)-8s [%(name)s] %(message)s"
_LINE_RE = re.compile(
    r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+([A-Z]+)\s+\[([^\]]*)\]\s?(.*)$"
)
_LEVELS = ("INFO", "WARNING", "ERROR")
# 日志行 ts 的合法格式（YYYY-MM-DD HH:MM[:SS]，容忍 ISO T 分隔）
_TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$")
_MAX_Q = 120

# 密钥脱敏（§8.2，复用发布侧 _scrub_err 模式）：日志 API 是 Web 暴露面——
# 未来 biliup 输出/外部错误若含凭证值，历史查询不得原样回传
_SECRET_RE = re.compile(r"(?i)(cookie|token|password|secret|authorization|bearer)\s*[:=]\s*([^\s,;\"']+)")  # noqa: E501
_SECRET_REPL = r"\1=***"

# 文件 mtime 缓存（§7.2）：轮询 8s 一次，文件不变则跳过重读
_CACHE: dict[str, tuple[float, list[dict]]] = {}


def _log_files() -> list[Path]:
    """新 → 旧（hertz.log, hertz.log.1, ...）——时间倒序读取的基础。"""
    base = Path(log_manager.log_dir) / "hertz.log"
    files = [base]
    for i in range(1, 5):
        rotated = base.with_name(f"hertz.log.{i}")
        if rotated.exists():
            files.append(rotated)
    return [f for f in files if f.exists()]


def _parse_lines(path: Path) -> list[dict]:
    """解析单个日志文件（mtime 缓存）：跳过非格式行（多行 traceback 等），
    返回时间倒序；脱敏在读取时一次完成。"""
    try:
        mtime = path.stat().st_mtime
    except OSError:
        return []
    cached = _CACHE.get(str(path))
    if cached is not None and cached[0] == mtime:
        return cached[1]
    try:
        raw = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    out: list[dict] = []
    for line in raw:
        m = _LINE_RE.match(line)
        if not m:
            continue
        ts, level, name, message = m.groups()
        out.append(
            {
                "ts": ts,
                "level": level if level in _LEVELS else "INFO",
                "logger": name,
                "message": _SECRET_RE.sub(_SECRET_REPL, message),
            }
        )
    out.reverse()  # 文件内正序 → 倒序（新在前）
    _CACHE[str(path)] = (mtime, out)
    return out


def _query_logs(
    *,
    limit: int,
    level: str,
    q: str,
    since: str,
    until: str,
) -> dict:
    """合并所有日志文件（新→旧），按筛选条件过滤，取 limit+1 判更多。

    since/until：ISO 时间字符串（YYYY-MM-DD HH:MM:SS 或 ISO 片段），
    语义含端点；until 是「加载更多」游标（返回比它更早的行）。
    注意：过滤必须在截断前完成（时间游标可能跨轮转文件）。
    """
    want_level = (level or "").strip().upper()
    if want_level not in _LEVELS:
        want_level = ""
    needle = (q or "").strip().lower()[:_MAX_Q]
    rows: list[dict] = []
    for f in _log_files():
        rows.extend(_parse_lines(f))
    if want_level:
        rows = [r for r in rows if r["level"] == want_level]
    if needle:
        rows = [r for r in rows if needle in r["message"].lower()]
    if since:
        rows = [r for r in rows if r["ts"] >= since]
    if until:
        rows = [r for r in rows if r["ts"] < until]
    has_more = len(rows) > limit
    return {"lines": rows[:limit], "count": min(len(rows), limit), "has_more": has_more}




@router.get("/logs")
async def logs_history(
    limit: int = Query(200, ge=1, le=2000),
    level: str = Query(""),
    q: str = Query(""),
    since: str = Query(""),
    until: str = Query(""),
) -> dict:
    """持久化日志历史（v0.8.7）：级别/关键字/时间游标翻页。

    输入校验（§8.1）：since/until 仅接受日志行时间戳格式，非法 422。
    """
    for cursor in (since, until):
        if cursor and not _TS_RE.match(cursor):
            from fastapi import HTTPException

            raise HTTPException(
                status_code=422,
                detail=f"invalid log cursor (expected YYYY-MM-DD HH:MM:SS): {cursor}",
            )
    try:
        return _query_logs(limit=limit, level=level, q=q, since=since, until=until)
    except Exception:  # noqa: BLE001 — 日志查询 best-effort，失败回退内存 buffer
        lines = log_manager.buffer.tail(limit)
        return {"lines": lines, "count": len(lines), "has_more": False, "fallback": True}
