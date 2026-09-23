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
    note: str | None = None  # v0.26 资产笔记：sidecar note 字段
    snippets: list[dict] | None = None  # v0.26 片段标记：sidecar snippets [{t0,t1,label}]


def _read_meta(meta_path: Path) -> dict:
    """Read sidecar `<name>.meta.json` (best effort, dict or {})."""
    try:
        data = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def _read_tags(meta_path: Path) -> list[str]:
    """Read tags from a sidecar `<name>.meta.json` (best effort)."""
    tags = _read_meta(meta_path).get("tags")
    if isinstance(tags, list):
        return [str(t) for t in tags][:8]
    return []


def _read_note(meta_path: Path) -> str | None:
    """Read note from sidecar (best effort, empty → None)."""
    note = _read_meta(meta_path).get("note")
    if isinstance(note, str) and note.strip():
        return note.strip()[:2000]
    return None


def _write_meta(media_path: Path, patch: dict) -> dict:
    """Merge patch into sidecar (keep other fields)."""
    meta_path = Path(f"{media_path}{META_SUFFIX}")
    data = _read_meta(meta_path)
    data.update(patch)
    data["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
    meta_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def write_tags(media_path: Path, tags: list[str]) -> dict:
    """Write tags into the `<name>.meta.json` sidecar (merge, keep other fields)."""
    return _write_meta(media_path, {"tags": [str(t).strip() for t in tags if str(t).strip()]})


def write_note(media_path: Path, note: str) -> dict:
    """Write note into sidecar (merge, keep other fields). Empty clears."""
    cleaned = str(note or "").strip()[:2000]
    return _write_meta(media_path, {"note": cleaned})


def _clean_snippet(raw: dict) -> dict | None:
    """Validate/normalize one snippet {t0, t1, label}. Invalid → None."""
    if not isinstance(raw, dict):
        return None
    try:
        t0 = float(raw.get("t0", 0))
        t1 = float(raw.get("t1", 0))
    except (TypeError, ValueError):
        return None
    if t0 < 0 or t1 <= t0 or t1 - t0 > 3600:
        return None
    label = str(raw.get("label") or "").strip()[:80]
    return {"t0": round(t0, 2), "t1": round(t1, 2), "label": label}


def _read_snippets(meta_path: Path) -> list[dict] | None:
    """Read snippets from sidecar (best effort, invalid entries dropped, empty → None)."""
    raw = _read_meta(meta_path).get("snippets")
    if not isinstance(raw, list):
        return None
    cleaned = [s for s in (_clean_snippet(r) for r in raw[:32]) if s is not None]
    return cleaned or None


def write_snippets(media_path: Path, snippets: list[dict]) -> dict:
    """Replace snippet list (merge, keep other fields). Max 32, validated."""
    cleaned = [s for s in (_clean_snippet(r) for r in (snippets or [])[:32]) if s is not None]
    return _write_meta(media_path, {"snippets": cleaned})


class LibraryBrowser:
    def scan(self, directory: Path, recursive: bool = False, limit: int = 500) -> list[dict]:
        if not directory.exists() or not directory.is_dir():
            return []
        entries: list[LibraryEntry] = []

        def walk(d: Path) -> None:
            if len(entries) >= limit:
                return
            try:
                files = sorted(d.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
            except OSError:
                return
            for p in files:
                if len(entries) >= limit:
                    return
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
                if p.is_dir():
                    if recursive:
                        # 递归模式：深入子目录聚合（Tag 侧栏用），不产出目录条目
                        walk(p)
                    else:
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
                    meta_exists = meta.exists()
                    entries.append(
                        LibraryEntry(
                            name=p.name,
                            path=str(p),
                            kind=classify(p.name),
                            size=st.st_size,
                            mtime=st.st_mtime,
                            thumb=str(t) if t.exists() else None,
                            mime=mimetypes.guess_type(p.name)[0],
                            tags=_read_tags(meta) if meta_exists else None,
                            note=_read_note(meta) if meta_exists else None,
                            snippets=_read_snippets(meta) if meta_exists else None,
                        )
                    )

        walk(directory)
        return [e.__dict__ for e in entries]

    def search(
        self, roots: list[Path], query: str, limit: int = 20, max_depth: int = 4
    ) -> list[dict]:
        """素材全局搜索（v0.2.3 ⌘K）：递归遍历允许根，按文件名/标签模糊匹配。

        路径匹配不做（命中目录即命中全部子文件，噪音大）；仅 name + tags，
        大小写不敏感。遍历在调用方线程池执行（文件 IO，AXIOM §7.2）。
        """
        q = query.strip().lower()
        if not q:
            return []
        out: list[LibraryEntry] = []

        def walk(p: Path, depth: int) -> None:
            if len(out) >= limit or depth > max_depth:
                return
            try:
                children = sorted(
                    p.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())
                )
            except OSError:
                return
            for child in children:
                if len(out) >= limit:
                    return
                if (
                    child.name.startswith(".")
                    or child.name in RUNTIME_FILES
                    or child.name.endswith(THUMB_SUFFIX)
                    or child.name.endswith(META_SUFFIX)
                ):
                    continue
                try:
                    st = child.stat()
                except OSError:
                    continue
                if child.is_dir():
                    if q in child.name.lower():
                        out.append(
                            LibraryEntry(
                                name=child.name + "/",
                                path=str(child),
                                kind="directory",
                                size=0,
                                mtime=st.st_mtime,
                            )
                        )
                    walk(child, depth + 1)
                elif child.is_file():
                    meta = Path(f"{child}{META_SUFFIX}")
                    meta_exists = meta.exists()
                    tags = _read_tags(meta) if meta_exists else []
                    note = _read_note(meta) if meta_exists else None
                    snippets = _read_snippets(meta) if meta_exists else None
                    if (
                        q in child.name.lower()
                        or any(q in t.lower() for t in tags)
                        or (note and q in note.lower())
                        or any(q in (s.get("label") or "").lower() for s in (snippets or []))
                    ):
                        thumb = Path(f"{child}{THUMB_SUFFIX}")
                        out.append(
                            LibraryEntry(
                                name=child.name,
                                path=str(child),
                                kind=classify(child.name),
                                size=st.st_size,
                                mtime=st.st_mtime,
                                thumb=str(thumb) if thumb.exists() else None,
                                mime=mimetypes.guess_type(child.name)[0],
                                tags=tags or None,
                                note=note,
                                snippets=snippets,
                            )
                        )
        for root in roots:
            walk(root, 0)
        return [e.__dict__ for e in out[:limit]]

    def info(self, path: Path) -> dict | None:
        if not path.exists():
            return None
        st = path.stat()
        out: dict = {
            "name": path.name,
            "path": str(path),
            "kind": classify(path.name) if path.is_file() else "directory",
            "size": st.st_size,
            "mtime": st.st_mtime,
        }
        if path.is_file():
            meta = Path(f"{path}{META_SUFFIX}")
            if meta.exists():
                out["tags"] = _read_tags(meta) or None
                out["note"] = _read_note(meta)
                out["snippets"] = _read_snippets(meta)
        return out

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
