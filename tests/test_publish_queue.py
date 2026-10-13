"""v0.12 发布队列单测：入队语义 / 每日转正 / 产能上限 / holding 隔离。

全部走 noop publisher（无需文件与凭据），配置经 runtime.yaml 写入
（与生产读取链一致，AXIOM §17）。
"""

from datetime import UTC, datetime
from uuid import uuid4

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
        reddit_score=100, upvote_ratio=0.9,
    )
    defaults.update(kw)
    # 标题默认按 source_id 派生，而不是全体共用一个 "queue item"。
    #
    # v0.38 加了发布期的标题指纹闸（文字故事线的 phash 为空，此前那里零查重），
    # 而这份夹具造出的多条条目标题完全相同 → 后一条发布被闸拦下。日限类测试
    # 于是测到的是「闸拦住了」而不是「日限生效」，报出一个与被测行为无关的数。
    #
    # 夹具造出的条目本来就该彼此不同——同名条目在真实世界里就是重复内容。
    defaults.setdefault("title", f"队列条目 {defaults['source_id']}")
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
    # v0.39：这条测试的本意是「**失败**不阻塞后续条目」，不是「判重会失败」。
    # 此前它靠「phash 重复」制造失败，等于把「判重=失败」这个 v0.39 判定为
    # bug 的语义焊进了断言里——修 bug 就得删测试，而它护的「失败隔离」是
    # 真价值，不该跟着删。所以改成用**真正的**发布失败。
    bad = await _make_item(source_id="bad-1")
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
    # 只有 bad 真的发布失败（传输层错误）；good 正常走完
    from backend.pipeline.publishers.router import PUBLISHERS

    original = PUBLISHERS["noop"].publish

    async def _flaky(ctx, item, *a, **kw):
        if getattr(item, "source_id", "") == "bad-1":
            # 403 = cookie 过期：明确不可重试，且能被 classify_error 认出来。
            # （没选 502：分类器不认它，会落进 publish 桶——那是另一件事，
            #  不该混在这条测试里顺手改掉。）
            raise RuntimeError("HTTP Error 403: Forbidden")
        return await original(ctx, item, *a, **kw)

    PUBLISHERS["noop"].publish = _flaky
    try:
        result = await svc.auto_publish_tick()
    finally:
        PUBLISHERS["noop"].publish = original

    assert result["failed"] == 1
    assert result["published"] == 1  # 单条失败不阻塞后续
    bad_row = await _fetch(bad.id)
    assert bad_row.status == ItemStatus.FAILED
    assert bad_row.error_class == "blocked", "按文本归类，不是一律写死 publish"
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

# ---------- 制作优先级（v0.26）：顺序落库 + engine 取件降序 ----------

@pytest.mark.asyncio
async def test_set_priority_assigns_descending_and_pending_respects_it() -> None:
    a = await _make_item(status=ItemStatus.DOWNLOADED, title="prio-a", source_id="prio-a")
    b = await _make_item(status=ItemStatus.DOWNLOADED, title="prio-b", source_id="prio-b")
    c = await _make_item(status=ItemStatus.DOWNLOADED, title="prio-c", source_id="prio-c")
    svc = _svc()
    res = await svc.set_priority([c.id, a.id, b.id])
    assert res == {"updated": 3}
    assert (await _fetch(c.id)).priority == 3
    assert (await _fetch(a.id)).priority == 2
    assert (await _fetch(b.id)).priority == 1
    engine = StepEngine(hub=None, settings=settings)
    from backend.pipeline.steps import get_step
    pending = await engine._pending("produce", get_step("produce")(), limit=10,
                                    statuses=("downloaded",))
    ours = [i.id for i in pending if i.id in (a.id, b.id, c.id)]
    assert ours == [c.id, a.id, b.id]


@pytest.mark.asyncio
async def test_priority_endpoint_validation(client) -> None:
    empty = await client.post("/api/pipeline/items/priority", json={"ordered_ids": []})
    assert empty.status_code == 422


@pytest.mark.asyncio
async def test_auto_publish_duplicate_skipped_not_blocking() -> None:
    """判重跳过的条目同样不得阻塞后续——它是「不投稿」，不是「发不出去」。

    与 `test_auto_publish_failure_marks_failed_not_blocking` 同一条性质：
    一条条目的结果不能决定后面的条目能不能发。区别只在**结果叫什么**：
    跳过 vs 失败。
    """
    from datetime import UTC, datetime, timedelta

    svc = _svc()
    before = dict(runtime_config.load())
    try:
        runtime_config.save({
            "pipeline_auto_publish": True,
            "pipeline_auto_promote_daily": 0,
            "pipeline_auto_publish_daily_limit": 5,
        })
        await _make_item(status=ItemStatus.PUBLISHED, source_id="dupp-1", phash="b" * 32)
        dup = await _make_item(source_id="dupx-1", phash="b" * 32,
                               title=f"近源新片 {uuid4().hex[:8]}")
        await svc.enqueue(dup.id, PHASE_READY)
        good = await _make_item(source_id="goodx-1", title=f"正常条目 {uuid4().hex[:8]}")
        await svc.enqueue(good.id, PHASE_READY)
        async with session_factory() as session:
            dup_row = await session.get(Item, dup.id)
            dup_row.scheduled_at = datetime.now(UTC) - timedelta(minutes=5)
            good_row = await session.get(Item, good.id)
            good_row.scheduled_at = datetime.now(UTC) - timedelta(minutes=1)
            await session.commit()

        result = await svc.auto_publish_tick()
        assert result["skipped"] == 1
        assert result["failed"] == 0, "跳过不是失败"
        assert result["published"] == 1, "跳过的条目不阻塞后续"
        assert (await _fetch(dup.id)).status == ItemStatus.SKIPPED
        assert (await _fetch(good.id)).status == ItemStatus.PUBLISHED
    finally:
        runtime_config.save(before)
