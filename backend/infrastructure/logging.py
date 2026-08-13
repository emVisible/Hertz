"""Dual-channel logging (AXIOM §28).

- progress channel: human-readable brief lines (console / web)
- detail channel: full context with stack traces (rotating file)
Buffered recent lines back up /api/logs when file history is unavailable (v0.8.9).
"""

import logging
import logging.handlers
import threading
from collections import deque
from datetime import UTC, datetime
from pathlib import Path

from backend.config import settings


class LogBuffer:
    """Thread-safe in-memory ring buffer of recent log lines."""

    def __init__(self, max_lines: int = 2000) -> None:
        self._lines: deque[dict] = deque(maxlen=max_lines)
        self._lock = threading.Lock()

    def append(self, level: str, message: str) -> None:
        with self._lock:
            self._lines.append(
                {
                    "ts": datetime.now(UTC).isoformat(),
                    "level": level,
                    "message": message,
                }
            )

    def tail(self, limit: int = 200) -> list[dict]:
        with self._lock:
            return list(self._lines)[-limit:]


class LogManager:
    def __init__(self, log_dir: Path | None = None) -> None:
        self.buffer = LogBuffer()
        # runtime.yaml 只能存字符串（YAML 无 Path 类型）——防御性转换
        self.log_dir = Path(log_dir or settings.log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)

        self.logger = logging.getLogger("hertz")
        self.logger.setLevel(logging.DEBUG)
        self.logger.propagate = False

        fmt_detail = logging.Formatter(
            "%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
        fmt_progress = logging.Formatter(
            "%(asctime)s %(levelname)-5s %(message)s", datefmt="%H:%M:%S"
        )

        file_handler = logging.handlers.RotatingFileHandler(
            self.log_dir / "hertz.log",
            maxBytes=5 * 1024 * 1024,
            backupCount=3,
            encoding="utf-8",
        )
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(fmt_detail)
        self.logger.addHandler(file_handler)

        console = logging.StreamHandler()
        console.setLevel(logging.INFO)
        console.setFormatter(fmt_progress)
        self.logger.addHandler(console)

        class BufferHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                self.buffer.append(record.levelname, self.format(record))

        buffer_handler = BufferHandler()
        buffer_handler.setFormatter(logging.Formatter("%(message)s"))
        buffer_handler.setLevel(logging.INFO)
        buffer_handler.buffer = self.buffer
        self.logger.addHandler(buffer_handler)

        # 系统日志面板（v0.3.0）：uvicorn/apscheduler 日志同样进 buffer——
        # 排查「立即完成/无明细」需要看到调度器与请求层信息
        # v0.3.5 降噪：httpx 每请求一条 INFO、apscheduler 5 分钟周期任务刷屏——
        # 这两个 logger 走独立 WARNING-only handler（仅失败请求/异常进面板），
        # uvicorn 启动信息保留 INFO
        warn_buffer = BufferHandler()
        warn_buffer.setLevel(logging.WARNING)
        warn_buffer.buffer = self.buffer  # v0.8.6 修复：此前未赋值，emit 即崩
        for name in ("apscheduler", "httpx"):
            extra = logging.getLogger(name)
            extra.setLevel(logging.INFO)
            extra.addHandler(warn_buffer)
            extra.propagate = False
        for name in ("uvicorn", "uvicorn.error"):
            extra = logging.getLogger(name)
            extra.setLevel(logging.INFO)
            extra.addHandler(buffer_handler)
            extra.propagate = False
        # 业务模块日志接入（v0.8.6）：backend.pipeline.* / backend.download.* /
        # backend.factory.* 的 WARNING+ 进文件与日志面板——采集失败此前只打 stderr，
        # hertz.log 与 Web 日志面板都看不到（运维盲区）
        for name in (
            "backend.pipeline",
            "backend.download",
            "backend.factory",
            "backend.routers",
        ):
            extra = logging.getLogger(name)
            extra.setLevel(logging.INFO)
            extra.addHandler(file_handler)
            extra.addHandler(warn_buffer)
            extra.propagate = False

    def get(self) -> logging.Logger:
        return self.logger


log_manager = LogManager()
