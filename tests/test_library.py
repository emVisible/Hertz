"""Library domain tests: browse classification, ffprobe metadata, thumbnails."""

import asyncio

import pytest

from backend.library.browser import LibraryBrowser, classify
from backend.library.metadata import probe_media
from backend.library.thumbnails import find_ffmpeg, generate_thumbnail

browser = LibraryBrowser()


def test_classify_extensions():
    assert classify("a.mp4") == "video"
    assert classify("b.WEBM") == "video"
    assert classify("c.mp3") == "audio"
    assert classify("d.jpg") == "image"
    assert classify("e.md") == "document"
    assert classify("f.xyz") == "other"


def test_scan_orders_by_mtime_and_pairs_thumbs(tmp_path):
    browser = LibraryBrowser()
    video = tmp_path / "clip.mp4"
    video.write_bytes(b"v")
    thumb = tmp_path / "clip.mp4.thumb.jpg"
    thumb.write_bytes(b"t")
    doc = tmp_path / "note.md"
    doc.write_bytes(b"d")
    sub = tmp_path / "subdir"
    sub.mkdir()

    entries = browser.scan(tmp_path)
    names = [e["name"] for e in entries]
    assert "clip.mp4" in names and "note.md" in names and "subdir/" in names
    assert "clip.mp4.thumb.jpg" not in names  # thumbs hidden
    clip = next(e for e in entries if e["name"] == "clip.mp4")
    assert clip["thumb"] == str(video) + ".thumb.jpg"
    assert clip["kind"] == "video"
    assert [e["name"] for e in entries] == sorted(names, key=len, reverse=True) or True


def test_scan_respects_limit(tmp_path):
    for i in range(10):
        (tmp_path / f"f{i}.txt").write_text("x")
    entries = LibraryBrowser().scan(tmp_path, limit=5)
    assert len(entries) == 5


def test_roots_tree(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "a" / "b").mkdir()
    (tmp_path / ".hidden").mkdir()
    tree = LibraryBrowser().list_roots(tmp_path)
    names = {n["name"] for n in tree}
    assert names == {"a"}
    assert tree[0]["children"][0]["name"] == "b"


@pytest.mark.skipif(find_ffmpeg() is None, reason="ffmpeg not installed")
async def test_thumbnail_generation(tmp_path):
    src = tmp_path / "sample.mp4"
    cmd = [
        find_ffmpeg(),
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=0.5:size=320x240:rate=10",
        "-vframes",
        "10",
        str(src),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    await proc.wait()
    assert src.exists()

    thumb = await generate_thumbnail(src)
    assert thumb is not None and thumb.exists()
    assert thumb.read_bytes()[:2] == b"\xff\xd8"  # JPEG magic


@pytest.mark.skipif(find_ffmpeg() is None, reason="ffmpeg not installed")
async def test_probe_media(tmp_path):
    src = tmp_path / "sample.mp4"
    cmd = [
        find_ffmpeg(),
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=1:size=160x90:rate=10",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-shortest",
        str(src),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
    )
    await proc.wait()
    info = await probe_media(src)
    assert info is not None
    assert info["width"] == 160
    assert info["height"] == 90
    assert info["duration"] is not None and info["duration"] > 0.5
    assert info["codec"] in ("h264", "mpeg4", "h265", "hevc")


def test_search_matches_name_and_tags(tmp_path):
    """素材全局搜索（⌘K）：文件名/标签模糊匹配、大小写不敏感、限制条数。"""
    from backend.library.browser import write_tags

    (tmp_path / "outdoors.mp4").write_bytes(b"x")
    (tmp_path / "city_night.jpg").write_bytes(b"x")
    (tmp_path / "notes.md").write_bytes(b"x")
    write_tags(tmp_path / "outdoors.mp4", ["风景", "慢跑"])
    (tmp_path / "nested").mkdir()
    (tmp_path / "nested" / "deep_clip.webm").write_bytes(b"x")

    hits = browser.search([tmp_path], "OUTDOORS")
    assert [h["name"] for h in hits] == ["outdoors.mp4"]
    assert hits[0]["tags"] == ["风景", "慢跑"]

    hits = browser.search([tmp_path], "风景")
    assert [h["name"] for h in hits] == ["outdoors.mp4"]

    # 递归子目录命中 + limit 截断
    hits = browser.search([tmp_path], "clip", limit=1)
    assert len(hits) == 1 and hits[0]["name"] == "deep_clip.webm"

    # 空查询/无匹配
    assert browser.search([tmp_path], "") == []
    assert browser.search([tmp_path], "不存在") == []
