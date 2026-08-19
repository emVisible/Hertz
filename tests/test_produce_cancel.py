"""取消制作（wave11）：协作式取消的完整契约测试。

覆盖：取消注册表语义、_run_cmd 轮询终止、produce_one 取消回滚
（清理半成品 → downloaded，不标 failed）、陈旧标志清理、幂等端点。
"""

import uuid

import pytest

from tests.test_pipeline_engine import _mk_item


@pytest.mark.asyncio
async def test_cancel_registry_roundtrip() -> None:
    """标志位置位/查询/清除 + 幂等。"""
    from backend.pipeline import cancel

    item_id = uuid.uuid4()
    assert cancel.is_cancelled(item_id) is False
    cancel.request_cancel(item_id)
    cancel.request_cancel(item_id)  # 幂等
    assert cancel.is_cancelled(item_id) is True
    assert cancel.is_cancelled(str(item_id)) is True  # str 等价
    cancel.clear_cancel(item_id)
    assert cancel.is_cancelled(item_id) is False


@pytest.mark.asyncio
async def test_run_cmd_cancel_terminates_process() -> None:
    """_run_cmd 轮询命中取消标志 → terminate 子进程 + 抛 ItemCancelledError。"""
    from backend.pipeline.cancel import (
        ItemCancelledError,
        request_cancel,
        reset_active_item,
        set_active_item,
    )
    from backend.pipeline.producers.media import _run_cmd

    import time

    item_id = uuid.uuid4()
    token = set_active_item(item_id)
    request_cancel(item_id)
    start = time.monotonic()
    try:
        with pytest.raises(ItemCancelledError):
            await _run_cmd(["sleep", "30"])
    finally:
        reset_active_item(token)
    # 0.25s 轮询粒度——必须快速返回（真杀了进程，而非等 30s 超时）
    assert time.monotonic() - start < 5.0


@pytest.mark.asyncio
async def test_run_cmd_without_cancel_check_unchanged() -> None:
    """无 cancel_check 时行为不变（默认路径仍走 communicate + 超时）。"""
    from backend.pipeline.producers.media import _run_cmd

    out = await _run_cmd(["sh", "-c", "printf hello"])
    assert out == b"hello"


@pytest.mark.asyncio
async def test_produce_one_cancelled_rolls_back(client, monkeypatch) -> None:
    """产线抛 ItemCancelledError → 条目回滚 downloaded + 半成品清理 + 标志清除。"""
    from pathlib import Path

    from backend.factory.registry import ServiceRegistry
    from backend.models.item import Item
    from backend.models.session import session_factory
    from backend.pipeline.cancel import ItemCancelledError, is_cancelled

    item_id = uuid.uuid4()
    fake_video = Path(f"/tmp/hertz-cancel-test-{item_id}.mp4")
    fake_video.write_bytes(b"partial")

    async with session_factory() as session:
        session.add(
            Item(
                id=item_id, status="downloaded", source="test",
                source_id=f"t-{item_id.hex[:8]}", title="取消测试",
                subreddit="r/test", author="tester",
                source_url="https://example.com/post",
                raw_path=str(Path(f"/tmp/raw-{item_id}.mp4")),
                video_path=str(fake_video),
            )
        )
        await session.commit()

    pipe = ServiceRegistry.get().pipeline

    async def _boom(*_a, **_k):
        raise ItemCancelledError("produce cancelled for test")

    monkeypatch.setattr(pipe.engine, "process_one", _boom)
    result = await pipe.produce_one(item_id)

    assert result == {"id": str(item_id), "status": "cancelled", "outcome": "cancelled"}
    assert is_cancelled(item_id) is False  # finally 清除标志

    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "downloaded"  # 不标 failed
        assert row.error is None
        assert row.video_path is None  # 半成品已清理
    assert not fake_video.exists()


@pytest.mark.asyncio
async def test_produce_one_clears_stale_flag_at_start(client, monkeypatch) -> None:
    """取消后立即重制：陈旧标志不得打断新一轮制作。"""
    from backend.factory.registry import ServiceRegistry
    from backend.models.item import Item
    from backend.models.session import session_factory
    from backend.pipeline.cancel import is_cancelled, request_cancel

    item_id = uuid.uuid4()
    async with session_factory() as session:
        session.add(
            Item(
                id=item_id, status="downloaded", source="test",
                source_id=f"t-{item_id.hex[:8]}", title="取消重制",
                subreddit="r/test", author="tester",
                source_url="https://example.com/post",
                raw_path=f"/tmp/raw-{item_id}.mp4",
            )
        )
        await session.commit()

    pipe = ServiceRegistry.get().pipeline

    async def _ok(*_a, **_k):
        return "ok"

    monkeypatch.setattr(pipe.engine, "process_one", _ok)
    request_cancel(item_id)  # 模拟上次取消的残留标志
    result = await pipe.produce_one(item_id)
    assert result["status"] == "queued"  # 未被陈旧标志打断
    assert is_cancelled(item_id) is False


@pytest.mark.asyncio
async def test_produce_cancel_endpoint_idempotent(client) -> None:
    """端点幂等：任意条目可取消（未在制作也无害），标志确实置位。"""
    from backend.pipeline.cancel import clear_cancel, is_cancelled

    item_id = await _mk_item()
    resp = await client.post(f"/api/pipeline/items/{item_id}/produce-cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"ok": True, "cancelling": True}
    assert is_cancelled(item_id) is True
    # 再次取消（幂等）
    resp2 = await client.post(f"/api/pipeline/items/{item_id}/produce-cancel")
    assert resp2.status_code == 200
    clear_cancel(item_id)