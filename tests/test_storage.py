"""FileStore atomic write / safe read tests."""

import pytest

from backend.infrastructure.storage import FileStore


@pytest.mark.asyncio
async def test_atomic_write_and_read(tmp_path) -> None:
    store = FileStore(data_dir=tmp_path)
    path = await store.atomic_write("sub/file.txt", "hello")
    assert path.exists()
    content = await store.safe_read("sub/file.txt")
    assert content == b"hello"


@pytest.mark.asyncio
async def test_safe_read_missing_returns_none(tmp_path) -> None:
    store = FileStore(data_dir=tmp_path)
    assert await store.safe_read("missing.txt") is None


@pytest.mark.asyncio
async def test_atomic_write_overwrites(tmp_path) -> None:
    store = FileStore(data_dir=tmp_path)
    await store.atomic_write("f.txt", "old")
    await store.atomic_write("f.txt", "new")
    assert (await store.safe_read("f.txt")) == b"new"
