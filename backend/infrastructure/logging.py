"""Dual-channel logging (AXIOM §28).

- progress channel: human-readable brief lines (console / web)
- detail channel: full context with stack traces (rotating file)
Buffered recent lines are served to the web UI via /api/logs/buffer.
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
        self.log_dir = log_dir or settings.log_dir
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

    def get(self) -> logging.Logger:
        return self.logger


log_manager = LogManager()
