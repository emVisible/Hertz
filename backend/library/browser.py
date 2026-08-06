"""LibraryBrowser — filesystem browsing with type classification.

素材系统的核心是 Tag（AXIOM §1.2 单一真相）：文件旁边可带
`<name>.meta.json` sidecar（HeartStone meta 模式）记录 tags/来源/时间，
scan 时合并进条目；不再是"固定文件夹解析"，而是 data_dir 根下的
统一素材空间按 tag 组织。
"""

import json
import mimetypes
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

VIDEO_EXTS = {"mp4", "webm", "mkv", "mov", "avi", "flv", "m4v", "ts", "m3u8"}
AUDIO_EXTS = {"mp3", "wav", "aac", "flac", "ogg", "m4a"}
IMAGE_EXTS = {"webp", "jpg", "jpeg", "png", "gif", "bmp", "heic", "avif"}
DOC_EXTS = {"txt", "md", "srt", "vtt", "pdf", "json", "yaml", "yml", "zip", "html"}

THUMB_SUFFIX = ".thumb.jpg"
META_SUFFIX = ".meta.json"

# 素材空间内的运行时文件：不作为素材展示
RUNTIME_FILES = {"runtime.yaml", "runtime.yaml.tmp", ".DS_Store", "thumbnails.db"}


@dataclass
class LibraryEntry:
    name: str
    path: str
    kind: str  # video | audio | image | document | directory | other
    size: int
    mtime: float
    thumb: str | None = None
    mime: str | None = None
    tags: list[str] | None = None


def _read_tags(meta_path: Path) -> list[str]:
    """Read tags from a sidecar `<name>.meta.json` (best effort)."""
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        tags = data.get("tags") if isinstance(data, dict) else None
        if isinstance(tags, list):
            return [str(t) for t in tags][:8]
    except (OSError, json.JSONDecodeError):
        pass
    return []


def write_tags(media_path: Path, tags: list[str]) -> dict:
    """Write tags into the `<name>.meta.json` sidecar (merge, keep other fields)."""
    meta_path = Path(f"{media_path}{META_SUFFIX}")
    data: dict = {}
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data["tags"] = [str(t).strip() for t in tags if str(t).strip()]
    data["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    meta_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


class LibraryBrowser:
    def scan(self, directory: Path, recursive: bool = False, limit: int = 500) -> list[dict]:
        if not directory.exists() or not directory.is_dir():
            return []
        entries: list[LibraryEntry] = []
        files = sorted(directory.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files:
            try:
                st = p.stat()
            except OSError:
                continue
            if (
                p.name.endswith(THUMB_SUFFIX)
                or p.name.endswith(META_SUFFIX)
                or p.name in RUNTIME_FILES
                or p.name.startswith(".")
            ):
                continue
            if p.is_dir() and not recursive:
                entries.append(
                    LibraryEntry(
                        name=p.name + "/",
                        path=str(p),
                        kind="directory",
                        size=0,
                        mtime=st.st_mtime,
                    )
                )
                continue
            if p.is_file():
                t = Path(f"{p}{THUMB_SUFFIX}")
                meta = Path(f"{p}{META_SUFFIX}")
                entries.append(
                    LibraryEntry(
                        name=p.name,
                        path=str(p),
                        kind=classify(p.name),
                        size=st.st_size,
                        mtime=st.st_mtime,
                        thumb=str(t) if t.exists() else None,
                        mime=mimetypes.guess_type(p.name)[0],
                        tags=_read_tags(meta) if meta.exists() else None,
                    )
                )
            if len(entries) >= limit:
                break
        return [e.__dict__ for e in entries]

    def info(self, path: Path) -> dict | None:
        if not path.exists():
            return None
        st = path.stat()
        return {
            "name": path.name,
            "path": str(path),
            "kind": classify(path.name) if path.is_file() else "directory",
            "size": st.st_size,
            "mtime": st.st_mtime,
        }

    def list_roots(self, base: Path, max_depth: int = 2) -> list[dict]:
        """Project directory tree for the library sidebar (AXIOM: browse from known roots)."""
        if not base.exists():
            return []
        return self._tree(base, 0, max_depth)

    def _tree(self, p: Path, depth: int, max_depth: int) -> list[dict]:
        out = []
        try:
            children = sorted(p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower()))
        except OSError:
            return out
        for child in children:
            if child.name.startswith(".") or child.name == "__pycache__":
                continue
            if child.is_dir():
                node = {"name": child.name, "path": str(child), "children": []}
                if depth < max_depth:
                    node["children"] = self._tree(child, depth + 1, max_depth)
                out.append(node)
        return out


def classify(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    if ext in IMAGE_EXTS:
        return "image"
    if ext in DOC_EXTS:
        return "document"
    return "other"
