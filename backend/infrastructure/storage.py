"""File system abstraction: atomic writes, safe reads, path management."""

import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from backend.config import settings


def next_output_slug(root: Path) -> str:
    """生成结构化的产物目录名：{YYYY-MM-DD}-{序号}，序号按当日已有目录递增。

    e.g. root 下已有 2026-08-04-01 → 返回 2026-08-04-02。
    跨天自动重置序号，目录名可读（日期 + 当日第几次），不再是一串 hex。
    """
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    seq = 0
    try:
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            name = entry.name
            if not name.startswith(f"{today}-"):
                continue
            try:
                seq = max(seq, int(name.rsplit("-", 1)[1]))
            except (ValueError, IndexError):
                continue
    except OSError:
        pass
    return f"{today}-{seq + 1:02d}"


class FileStore:
    """All file paths in Hertz flow through this store."""

    def __init__(self, data_dir: Path | None = None, output_dir: Path | None = None) -> None:
        # 锚定链必须单一绝对根（AXIOM §33）：data_dir 相对化时锚到 cwd，
        # 否则 resolve() 锚 data_dir 而 output_root() 仍返回相对路径，
        # 同一 run_dir 在写入（锚定）与裸 Path 检查（cwd）下指向两个位置。
        d = Path(data_dir or settings.data_dir)
        self.data_dir = d if d.is_absolute() else d.resolve()
        self.output_dir = Path(output_dir or settings.output_dir)
        self.ensure_dir(self.data_dir)
        self.ensure_dir(self.output_root())

    def ensure_dir(self, path: Path) -> Path:
        path.mkdir(parents=True, exist_ok=True)
        return path

    def resolve(self, path: Path | str) -> Path:
        """Resolve a possibly-relative path against the data dir."""
        p = Path(path)
        return p if p.is_absolute() else self.data_dir / p

    def output_root(self) -> Path:
        """Absolute output root, anchored at data_dir (cwd-independent)."""
        p = Path(self.output_dir)
        return p if p.is_absolute() else self.data_dir / p

    def run_dir(self, run) -> Path:
        """运行产物目录（绝对）：以 run.output_dir 为准，旧版无该列 → hex 兜底。

        全系统唯一出口（engine/studio 共用），避免三处各写一套
        `run.output_dir or studio/{hex}`（AXIOM §1.2）。
        """
        rel = run.output_dir if run and run.output_dir else f"studio/{run.id.hex}"
        return self.output_root() / rel

    async def atomic_write(self, path: Path | str, content: bytes | str) -> Path:
        """Write via temp file + rename — never leaves a half-written file."""
        target = self.resolve(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=".tmp-")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(content.encode("utf-8") if isinstance(content, str) else content)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return target

    async def safe_read(self, path: Path | str) -> bytes | None:
        """Read a file; None if missing or unreadable — never raises for absence."""
        target = self.resolve(path)
        try:
            return target.read_bytes()
        except (OSError, IsADirectoryError):
            return None

    def exists(self, path: Path | str) -> bool:
        return self.resolve(path).exists()


file_store = FileStore()
