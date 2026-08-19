"""v0.12 发布队列单测：入队语义 / 每日转正 / 产能上限 / holding 隔离。

全部走 noop publisher（无需文件与凭据），配置经 runtime.yaml 写入
（与生产读取链一致，AXIOM §17）。
"""

from datetime import UTC, datetime

import pytest

from backend.config import runtime_config, settings
from backend.infrastructure.events import EventHub
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline.engine import StepEngine
from backend.pipeline.errors import InvalidItemStateError
from backend.pipeline.publish_queue import (
    PHASE_HOLDING,
    PHASE_NONE,
    PHASE_READY,
    local_day_bounds,
)
from backend.pipeline.service import PipelineService


def _svc():
    hub = EventHub()
    return PipelineService(hub=hub, engine=StepEngine(hub=hub, settings=settings))


_CREATED: list = []


async def _make_item(**kw) -> Item:
    defaults = dict(
        status=ItemStatus.APPROVED, source="reddit", source_id="q-1",
        title="queue item", reddit_score=100, upvote_ratio=0.9,
    )
    defaults.update(kw)
    async with session_factory() as session:
        item = Item(**defaults)
        session.add(item)
        await session.commit()
        _CREATED.append(item.id)
        return item


@pytest.fixture(autouse=True)
def _clean_runtime_config():
    yield
    runtime_config.save({})


@pytest.fixture(autouse=True)
async def _clean_created_items():
    yield
    if not _CREATED:
        return
    async with session_factory() as session:
        for item_id in _CREATED:
            row = await session.get(Item, item_id)
            if row is not None:
                await session.delete(row)
        await session.commit()
        _CREATED.clear()


async def _fetch(item_id) -> Item:
    async with session_factory() as session:
        return await session.get(Item, item_id)


# ---------- 入队语义 ----------

@pytest.mark.asyncio
async def test_enqueue_holding_clears_schedule() -> None:
    from datetime import UTC, datetime, timedelta

    item = await _make_item(scheduled_at=datetime.now(UTC) + timedelta(hours=1))
    result = await _svc().enqueue(item.id, PHASE_HOLDING)
    assert result["queue_phase"] == PHASE_HOLDING
    row = await _fetch(item.id)
    assert row.queue_phase == PHASE_HOLDING
    assert row.scheduled_at is None  # holding 语义 = 无排期待命


@pytest.mark.asyncio
async def test_enqueue_ready_keeps_schedule_and_batch() -> None:
    from datetime import UTC, datetime, timedelta

    svc = _svc()
    scheduled = datetime.now(UTC) + timedelta(hours=3)
    item = await _make_item(scheduled_at=scheduled)
    result = await svc.enqueue(item.id, PHASE_READY)
    assert result["queue_phase"] == PHASE_READY
    row = await _fetch(item.id)
    assert row.scheduled_at == scheduled  # 已有排期保留
    # 批量出队
    batch = await svc.enqueue_batch([item.id], PHASE_NONE)
    assert batch == {"ok": 1, "failed": []}
    row = await _fetch(item.id)
    assert row.queue_phase == PHASE_NONE


@pytest.mark.asyncio
async def test_enqueue_requires_approved() -> None:
    item = await _make_item(status=ItemStatus.QUEUED)
    with pytest.raises(InvalidItemStateError):
        await _svc().enqueue(item.id, PHASE_HOLDING)


@pytest.mark.asyncio
async def test_enqueue_rejects_unknown_phase() -> None:
    item = await _make_item()
    with pytest.raises(ValueError):
        await _svc().enqueue(item.id, "weird")


# ---------- 每日转正（holding → ready） ----------

@pytest.mark.asyncio
async def test_auto_promote_orders_by_seq_and_respects_limit() -> None:
    runtime_config.save({"pipeline_auto_publish": True, "pipeline_auto_promote_daily": 2})
    svc = _svc()
    items = [await _make_item(source_id=f"p-{i}") for i in range(4)]
    for i in items:
        await svc.enqueue(i.id, PHASE_HOLDING)
    promoted = await svc._auto_promote_now(datetime.now(UTC))
    assert promoted == 2  # 只转配置数量
    phases = {str(i.id): (await _fetch(i.id)).queue_phase for i in items}
    assert list(phases.values()).count(PHASE_READY) == 2
    assert list(phases.values()).count(PHASE_HOLDING) == 2


@pytest.mark.asyncio
async def test_holding_never_promoted_or_published_by_tick() -> None:
    from datetime import UTC, datetime, timedelta

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_auto_promote_daily": 0,  # 关转正：holding 应保持不动
        "pipeline_auto_publish_daily_limit": 10,
    })
    svc = _svc()
    holding = await _make_item(source_id="hold-1")
    await svc.enqueue(holding.id, PHASE_HOLDING)
    ready = await _make_item(
        source_id="ready-1", scheduled_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    await svc.enqueue(ready.id, PHASE_READY)
    result = await svc.auto_publish_tick()
    assert result["published"] == 1  # 只发布 ready
    row = await _fetch(holding.id)
    assert row.queue_phase == PHASE_HOLDING
    assert row.status == ItemStatus.APPROVED  # holding 未被发布


# ---------- 产能上限 ----------

@pytest.mark.asyncio
async def test_auto_publish_respects_daily_limit() -> None:
    from datetime import UTC, datetime, timedelta

    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_auto_promote_daily": 0,
        "pipeline_auto_publish_daily_limit": 2,
    })
    svc = _svc()
    ids = []
    for i in range(4):
        item = await _make_item(
            source_id=f"due-{i}", scheduled_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        await svc.enqueue(item.id, PHASE_READY)
        ids.append(item.id)
    result = await svc.auto_publish_tick()
    assert result["published"] == 2  # 上限 2
    assert result["used_today"] == 2
    # 再次 tick 不超发（已用计数 + 剩余未到点）
    result2 = await svc.auto_publish_tick()
    assert result2["published"] == 0
    published = 0
    for i in ids:
        row = await _fetch(i)
        if row.status == ItemStatus.PUBLISHED and (row.publish_json or {}).get("auto"):
            published += 1
    assert published == 2  # 自动发布条目标记 auto（产能计数依据）


@pytest.mark.asyncio
async def test_auto_publish_failure_marks_failed_not_blocking() -> None:
    from datetime import UTC, datetime, timedelta

    svc = _svc()
    # bad：phash 与已发布条目重复 → publish_one 去重闸门抛错（tick 标记 failed）
    await _make_item(
        status=ItemStatus.PUBLISHED, source_id="dup-1",
        phash="a" * 32,
    )
    bad = await _make_item(source_id="bad-1", phash="a" * 32)
    await svc.enqueue(bad.id, PHASE_READY)
    good = await _make_item(source_id="good-1")
    await svc.enqueue(good.id, PHASE_READY)
    # 手动把排期拨到过去，模拟到点（enqueue 自动分槽给的是未来窗口）；
    # bad 更早 → 先失败，good 后成功，验证失败不阻塞
    async with session_factory() as session:
        bad_row = await session.get(Item, bad.id)
        bad_row.scheduled_at = datetime.now(UTC) - timedelta(minutes=5)
        good_row = await session.get(Item, good.id)
        good_row.scheduled_at = datetime.now(UTC) - timedelta(minutes=1)
        await session.commit()
    runtime_config.save({
        "pipeline_auto_publish": True,
        "pipeline_auto_promote_daily": 0,
        "pipeline_auto_publish_daily_limit": 5,
    })
    result = await svc.auto_publish_tick()
    assert result["failed"] == 1
    assert result["published"] == 1  # 单条失败不阻塞后续
    bad_row = await _fetch(bad.id)
    assert bad_row.status == ItemStatus.FAILED
    assert bad_row.error_class == "publish"
    good_row = await _fetch(good.id)
    assert good_row.status == ItemStatus.PUBLISHED
    assert (good_row.publish_json or {}).get("auto") is True


@pytest.mark.asyncio
async def test_auto_publish_disabled_skips() -> None:
    runtime_config.save({"pipeline_auto_publish": False})
    result = await _svc().auto_publish_tick()
    assert result["enabled"] is False
    assert result["published"] == 0


# ---------- 看板与本地日 ----------

@pytest.mark.asyncio
async def test_queue_view_shape() -> None:
    runtime_config.save({"pipeline_auto_publish": True, "pipeline_auto_publish_daily_limit": 5})
    svc = _svc()
    h = await _make_item(source_id="view-h")
    await svc.enqueue(h.id, PHASE_HOLDING)
    r = await _make_item(source_id="view-r")
    await svc.enqueue(r.id, PHASE_READY)
    view = await svc.queue_view()
    assert len(view["holding"]) == 1
    assert len(view["ready"]) == 1
    assert view["today"]["daily_limit"] == 5
    assert view["today"]["auto_published"] == 0
    assert view["today"]["auto_enabled"] is True


def test_local_day_bounds_covers_local_midnight() -> None:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    start, end = local_day_bounds(now)
    assert start < end
    # 本地零点一定落在 [start, end) 内
    local_tz = datetime.now().astimezone().tzinfo
    local_midnight = now.astimezone(local_tz).replace(hour=0, minute=0, second=0, microsecond=0)
    assert start <= local_midnight.astimezone(UTC) < end


# ---------- API 层冒烟（路由薄包装 + 全局错误映射） ----------

@pytest.mark.asyncio
async def test_queue_api_enqueue_view_and_422(client) -> None:

    item = await _make_item(source_id="api-1")
    resp = await client.post(f"/api/pipeline/items/{item.id}/queue", json={"phase": "holding"})
    assert resp.status_code == 200
    assert resp.json()["queue_phase"] == "holding"

    view = await client.get("/api/pipeline/publish/queue")
    assert view.status_code == 200
    data = view.json()
    assert any(i["id"] == str(item.id) for i in data["holding"])
    assert "daily_limit" in data["today"]

    bad = await client.post(f"/api/pipeline/items/{item.id}/queue", json={"phase": "weird"})
    assert bad.status_code == 422

    missing = await client.post(
        "/api/pipeline/items/00000000-0000-0000-0000-000000000000/queue",
        json={"phase": "ready"},
    )
    assert missing.status_code == 404

    batch = await client.post(
        "/api/pipeline/items/batch/queue",
        json={"ids": [str(item.id)], "phase": ""},
    )
    assert batch.status_code == 200
    assert batch.json() == {"ok": 1, "failed": []}