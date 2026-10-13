"""发布可靠性（v0.38）：重试 + 限速熔断。

这一层守护的是**链路的终点**。此前 `service_publish` 全文没有
retry/backoff/sleep——一次网络抖动 = 一次已经被消费掉的调度槽位。

测试重点在三件事上，它们都是「错了不会报错、只会悄悄变坏」的类型：

1. **永久性失败不重试**——403/404 是 cookie 过期，重试一万次还是同一结果
2. **被限流时标 FAILED 是错的**——条目没坏，只是现在发不出去
3. **退避递增且有上限**——无限退避会把整个 tick 堵死
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.pipeline import ResourceCooldown
from backend.models.session import session_factory
from backend.pipeline.publish_reliability import (
    COOLDOWN_PREFIX,
    backoff_seconds,
    clear_cooldown,
    cooldown_domain,
    cooldown_left,
    is_retryable,
    publish_with_retry,
    trip_cooldown,
)
from backend.pipeline.publishers.router import PUBLISHERS


@pytest.fixture
async def clean_cooldown():
    async with session_factory() as session:
        from sqlalchemy import delete

        await session.execute(
            delete(ResourceCooldown).where(
                ResourceCooldown.domain.like(f"{COOLDOWN_PREFIX}%"))
        )
        await session.commit()
    yield


class _Sleeper:
    """记录被请求的等待时长，不真的睡——测试不该为退避付出时间代价。"""

    def __init__(self) -> None:
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


# ---------- 只重试瞬时失败 ----------

@pytest.mark.parametrize(
    "err",
    [
        "HTTP 429 Too Many Requests",
        "rate limit exceeded",
        "command timed out after 1800s",
        "connection reset by peer",
        "Connection refused",
        "Temporary failure in name resolution",
        "SSL handshake failure",
        "broken pipe",
    ],
)
def test_transient_failures_are_retryable(err: str) -> None:
    assert is_retryable(err) is True, f"「{err}」是瞬时失败，应当重试"


@pytest.mark.parametrize(
    "err",
    [
        "HTTP Error 403: Forbidden",   # cookie 过期——重试一万次还是同一结果
        "HTTP Error 404: Not Found",
        "duplicate detected: phash xxx already published",
        "片段「X」没有原始媒体文件",
        "cannot publish item in state rejected",
    ],
)
def test_permanent_failures_are_not_retryable(err: str) -> None:
    """对永久性失败重试是纯浪费，而且会加重对方的封禁。"""
    assert is_retryable(err) is False, f"「{err}」是永久失败，不该重试"


def test_backoff_grows_and_is_capped() -> None:
    seq = [backoff_seconds(n, base=5.0) for n in range(1, 9)]
    assert seq[:4] == [5.0, 10.0, 20.0, 40.0], f"退避应指数增长：{seq[:4]}"
    # 再往上必须封顶：一次 tick 里阻塞太久会让整轮发布停摆
    assert max(seq) <= 60.0, f"退避必须有上限：{seq}"
    assert seq == sorted(seq)


# ---------- 重试执行 ----------

@pytest.mark.asyncio
async def test_publish_succeeds_first_try_no_sleep(clean_cooldown) -> None:
    calls = {"n": 0}

    async def ok():
        calls["n"] += 1
        return {"bvid": "BV1"}

    sleeper = _Sleeper()
    result, attempts = await publish_with_retry(ok, target="bilibili", sleep=sleeper)
    assert result == {"bvid": "BV1"}
    assert attempts == 1
    assert calls["n"] == 1
    assert sleeper.waits == []


@pytest.mark.asyncio
async def test_transient_failure_is_retried_then_succeeds(clean_cooldown) -> None:
    calls = {"n": 0}

    async def flaky():
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("connection reset by peer")
        return {"bvid": "BV1"}

    sleeper = _Sleeper()
    result, attempts = await publish_with_retry(flaky, target="bilibili", sleep=sleeper)
    assert result == {"bvid": "BV1"}
    assert attempts == 3
    assert calls["n"] == 3
    assert len(sleeper.waits) == 2, "两次失败应各等一次"
    assert sleeper.waits[1] > sleeper.waits[0], "退避应递增"


@pytest.mark.asyncio
async def test_permanent_failure_is_not_retried(clean_cooldown) -> None:
    calls = {"n": 0}

    async def forbidden():
        calls["n"] += 1
        raise RuntimeError("HTTP Error 403: Forbidden")

    sleeper = _Sleeper()
    with pytest.raises(RuntimeError, match="403"):
        await publish_with_retry(forbidden, target="bilibili", sleep=sleeper)
    assert calls["n"] == 1, "403 不该重试——cookie 过期重试没有意义"
    assert sleeper.waits == []


@pytest.mark.asyncio
async def test_exhausted_retries_raise_last_error(clean_cooldown) -> None:
    """全部尝试失败时抛**最后一次**异常。

    抛「重试了 N 次」这种没信息量的包装，会让上层日志失去真正的失败原因。
    """
    attempts_seen = {"n": 0}

    async def always_fail():
        attempts_seen["n"] += 1
        raise RuntimeError(f"connection reset #{attempts_seen['n']}")

    with pytest.raises(RuntimeError, match="connection reset #3"):
        await publish_with_retry(
            always_fail, target="bilibili", sleep=_Sleeper())
    assert attempts_seen["n"] == 3


# ---------- 限速熔断 ----------

@pytest.mark.asyncio
async def test_rate_limit_trips_cooldown_after_exhaustion(clean_cooldown) -> None:
    """重试到限额流仍失败 → 这条记忆要让**后续发布**也停下来。

    否则下一个 tick 会拿同一条继续撞，把限流越撞越深。
    """

    async def limited():
        raise RuntimeError("HTTP Error 429: Too Many Requests")

    with pytest.raises(RuntimeError, match="429"):
        await publish_with_retry(limited, target="bilibili", sleep=_Sleeper())

    assert await cooldown_left("bilibili") > 0, "限流后应进入冷却"


@pytest.mark.asyncio
async def test_cooldown_grows_then_clears_on_success(clean_cooldown) -> None:
    """连着撞 → 越等越久；任何一次成功 → 立刻解冻。

    这是熔断的标准形状，也是下载侧 `ResourceCooldown` 已在用的形状。
    """
    first = await trip_cooldown("bilibili")
    second = await trip_cooldown("bilibili")
    assert second >= first, f"连续失败应等更久：{first} → {second}"
    assert await cooldown_left("bilibili") > 0

    await clear_cooldown("bilibili")
    assert await cooldown_left("bilibili") == 0


@pytest.mark.asyncio
async def test_cooldown_is_scoped_per_target(clean_cooldown) -> None:
    """熔断按目标隔离——B 站被限流不该连累别的目标。"""

    if "bilibili" not in PUBLISHERS:  # pragma: no cover
        pytest.skip("biliup 不可用")
    await trip_cooldown("bilibili")
    assert await cooldown_left("bilibili") > 0
    assert await cooldown_left("export") == 0, "export 不该被 bilibili 的熔断牵连"


@pytest.mark.asyncio
async def test_cooldown_does_not_trip_on_non_rate_limit_failure(clean_cooldown) -> None:
    """403 不该触发熔断——那是 cookie 过期，等再久也一样。

    把 403 当限流会冻结整个发布链路，而真正需要的是让用户去换 cookie。
    """

    async def forbidden():
        raise RuntimeError("HTTP Error 403: Forbidden")

    with pytest.raises(RuntimeError):
        await publish_with_retry(forbidden, target="bilibili", sleep=_Sleeper())
    assert await cooldown_left("bilibili") == 0


@pytest.mark.asyncio
async def test_success_clears_existing_cooldown(clean_cooldown) -> None:
    """发布成功即解冻：哪怕之前冻着，成功一次就说明恢复了。"""
    await trip_cooldown("bilibili")

    async def ok():
        return {"bvid": "BV1"}

    await publish_with_retry(ok, target="bilibili", sleep=_Sleeper())
    assert await cooldown_left("bilibili") == 0


def test_cooldown_domain_is_namespaced() -> None:
    """限速与下载侧的冷却共用一张表，必须靠前缀区分用途。"""
    assert cooldown_domain("bilibili") == "publish:bilibili"
    assert cooldown_domain("bilibili") != "cdn.example.com"

# ---------- 发布期查重：文字故事线此前完全没有闸（v0.38） ----------

@pytest.fixture
async def clean_items():
    """清掉本文件造的条目——共享库，残留会串到别的文件。"""
    from sqlalchemy import delete

    from backend.models.item import Item
    from backend.models.session import session_factory

    async def _clean():
        async with session_factory() as session:
            await session.execute(
                delete(Item).where(Item.source == "test"))
            await session.commit()

    await _clean()
    yield
    await _clean()


async def _mk_item(**kw) -> str:
    from backend.models.item import Item
    from backend.models.session import session_factory

    async with session_factory() as session:
        row = Item(source="test", item_type="text_only", **kw)
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return str(row.id)


@pytest.mark.asyncio
async def test_published_title_duplicate_detected(clean_items):
    """同标题的条目已经发出去了 → 判重。

    这是 AI 原创故事通道唯一的一道闸：文字故事的 phash 显式为 None，发布闸里的
    `if item.phash:` 对它不成立。
    """
    from backend.models.item import ItemStatus
    from backend.pipeline.dedupe import find_published_title_duplicate

    await _mk_item(
        source_id="pub-dup-1", status=ItemStatus.PUBLISHED,
        title="他在末班车上第一次哭了",
    )

    assert await find_published_title_duplicate("他在末班车上第一次哭了") is True
    # 大小写与标点差异不应让它漏
    assert await find_published_title_duplicate("他在末班车上第一次哭了！") is True
    # 不同标题不算
    assert await find_published_title_duplicate("另一个人讲的完全不同的故事") is False


@pytest.mark.asyncio
async def test_unpublished_item_does_not_trip_title_gate(clean_items):
    """只比「已发布」——未发布的同标题条目不该拦住这一条。"""
    from backend.models.item import ItemStatus
    from backend.pipeline.dedupe import find_published_title_duplicate

    await _mk_item(
        source_id="not-pub-1", status=ItemStatus.APPROVED,
        title="这一篇稿子还没有发出去",
    )
    assert await find_published_title_duplicate("这一篇稿子还没有发出去") is False


@pytest.mark.asyncio
async def test_title_gate_ignores_itself_on_republish(clean_items):
    """重新发布同一条（改标题重发）不能被自己挡住。"""
    import uuid as _uuid

    from backend.models.item import ItemStatus
    from backend.pipeline.dedupe import find_published_title_duplicate

    rid = _uuid.UUID(await _mk_item(
        source_id="self-pub-1", status=ItemStatus.PUBLISHED, title="同一个标题在这里"))

    assert await find_published_title_duplicate("同一个标题在这里") is True
    assert await find_published_title_duplicate("同一个标题在这里", exclude_id=rid) is False


@pytest.mark.asyncio
async def test_publish_gate_blocks_text_story_duplicate(clean_items):
    """端到端：文字故事（phash=None）撞上已发布同名标题 → 发布被拒。

    没有这条，用户会把重复内容真的发出去——账号是资产，重复投稿的代价
    （限流乃至封号）远高于少发一条。

    走的 target 是 `noop`：查询它自己就会跳过上传，我们只验**闸**。
    """
    from backend.factory.registry import ServiceRegistry
    from backend.models.item import ItemStatus

    await _mk_item(source_id="gate-dup", status=ItemStatus.PUBLISHED, title="同一个故事的两份稿子")
    dup_id = await _mk_item(
        source_id="gate-dup-2", status=ItemStatus.APPROVED, title="同一个故事的两份稿子")

    svc = ServiceRegistry.get().pipeline
    with pytest.raises(ValueError, match="duplicate detected"):
        await svc.publish_one(dup_id, target="noop")


def test_publish_gate_keeps_title_check_outside_phash_branch():
    """标题指纹闸必须在 `if item.phash:` **之外**（源码级守卫）。

    文字故事的 phash 显式为 None，而发布闸原本写成 `if item.phash: ...`——把闸
    放在这个分支里，等于对整条文字产线（以及 AI 原创故事这条战略通道）**零查重**。

    这类错误没有任何运行时报错：功能只是「悄悄不见了」，所以只能靠源码守卫钉住。
    """
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[1] / "backend/pipeline/service_publish.py"
    ).read_text(encoding="utf-8")
    title_gate = src.index("find_published_title_duplicate")
    phash_gate = src.index("find_phash_duplicate")
    # 标题闸在文本上位于 phash 闸之后，且不在它的 if 分支缩进内
    assert title_gate > phash_gate, "标题闸应独立于 phash 闸"
    line = src[:title_gate].rsplit("\n", 1)[-1]
    assert not line.lstrip().startswith(("if ", "elif ")), (
        f"标题闸被条件包住了（{line.strip()!r}）——phash 为空的条目会绕过它"
    )


# ---------- 发布可靠性必须可观测（v0.38） ----------

@pytest.mark.asyncio
async def test_publish_status_exposes_cooldown_and_failures(client, clean_cooldown, clean_items):
    """发布状态端点要报出：目标是否被熔断、近 7 天失败都归到哪一类。

    ## 为什么这条必须存在

    重试与熔断做出来之后，状态存进了 `resource_cooldown`——但**没有任何出口**。
    一个不可观测的状态等于不存在：用户看到「发布失败」，界面告诉他「失败」，
    却既不知道目标是不是正被限流冻结，也看不出最近失败的原因分布。
    """
    from backend.pipeline.publish_reliability import trip_cooldown

    await trip_cooldown("bilibili")
    r = await client.get("/api/pipeline/publish/status")
    body = r.json()

    assert body["cooldowns_s"].get("bilibili", 0) > 0, "熔断状态必须能从端点看到"
    assert body["max_attempts"] >= 1, "界面要知道会重试几次"
    assert "failures_7d_by_class" in body

    # target_throttled 是给「当前生效目标」的便捷判断：默认配置是 noop，
    # 而 noop 从不被熔断（本地记意图），所以必须是 False——这正是「不误报」。
    assert body["target_throttled"] is (
        body["target"] in body["cooldowns_s"]
    )


@pytest.mark.asyncio
async def test_publish_status_clean_when_nothing_wrong(client, clean_cooldown, clean_items):
    """没出问题时不要平白报警——「熔断中」指示灯常亮等于没有指示灯。"""
    r = await client.get("/api/pipeline/publish/status")
    body = r.json()
    assert body["target_throttled"] is False
    assert body["cooldowns_s"] == {}


@pytest.mark.asyncio
async def test_auto_publish_failure_is_classified_not_blanket(clean_items):
    """发布失败必须按文本归类，不能一律写死 `publish`。

    一律写死会让**所有**发布失败落进同一个桶，失败看板（按 error_class 聚合
    + 批量重试）于是答不出「为什么发不出去」：cookie 过期、限流、视频格式问题
    看起来一模一样。

    直接对 `PhaseEngine` 里那条 except 分支所依赖的归类行为做断言，再补一条
    源码级守卫锁住「不许回退成写死的 publish」。驱动整个 tick 需要先造出
    ready 相位的条目（enqueue 语义），那是另一层测试关心的事。
    """
    from backend.pipeline.errors import classify_error

    # 发布语境下这些文本必须分得开
    assert classify_error("HTTP Error 403: Forbidden", step="publish") == "blocked"
    assert classify_error("HTTP Error 429: Too Many Requests", step="publish") == "rate_limit"
    assert classify_error("biliup exited 1", step="publish") == "publish"


def test_auto_publish_branch_does_not_hardcode_publish_class():
    """源码级守卫：except 分支不得再写死 `error_class = "publish"`。

    这类退化**不报错**——功能只是悄悄变回「所有失败一个桶」，所以只能靠源码断言。
    """
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[1]
        / "backend/pipeline/service_promotion.py"
    ).read_text(encoding="utf-8")
    assert 'error_class = "publish"' not in src, (
        "发布失败又退回写死 publish——失败看板将无法回答「为什么发不出去」"
    )
    assert "classify_error(" in src, "应当用 classify_error 归类"


async def _clear_failed(*classes: str) -> None:
    """清掉指定失败分类下的**全部**条目（含其它测试文件漏下的）。

    `retry_class` 是**按类全局**操作的：只看自己造的条目去断言返回条数，等于
    依赖「整个共享库恰好是干净的」——别的文件漏一条 FAILED/internal 进来，
    这条测试就会在全量跑时莫名失败，而单跑时通过。这类「单跑绿、全量红」的测试
    比没有测试更糟：它训练人忽略红灯。
    """
    from sqlalchemy import delete

    from backend.models.item import Item

    async with session_factory() as session:
        await session.execute(
            delete(Item).where(Item.error_class.in_(classes)))
        await session.commit()


@pytest.mark.asyncio
async def test_retry_class_respects_budget_and_force_rescues_it(clean_items):
    """`retry_count` 此前只写不读：一个永久失败的条目能被无限重试。

    预算必须真的生效，且必须有出口——否则用户只会看到「重试没反应」，
    而不知道是自己被防住了。
    """
    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.helpers import back_status_for

    await _clear_failed("internal")
    svc = ServiceRegistry.get().pipeline
    await _mk_item(source_id="budget-1", status=ItemStatus.FAILED,
                   error="boom", error_class="internal",
                   retry_count=3)  # 已用满默认预算 3

    n = await svc.retry_class("internal")
    assert n == 0, "超预算的条目不应被自动复位"
    assert svc._last_retry_skipped, "跳过的条目必须报出来，否则用户以为全处理了"

    # 它必须仍留在失败态、且保留 error_class——这是人工排查的线索
    async with session_factory() as session:
        row = (await session.execute(
            select(Item).where(Item.source_id == "budget-1"))).scalar_one()
        assert row.status == ItemStatus.FAILED
        assert row.error_class == "internal"

    # 人的决定能越过预算
    assert await svc.retry_class("internal", force=True) == 1
    async with session_factory() as session:
        row = (await session.execute(
            select(Item).where(Item.source_id == "budget-1"))).scalar_one()
        assert row.status == back_status_for(row)
        assert row.error_class == ""


@pytest.mark.asyncio
async def test_retry_class_budget_counts_down_per_round(clean_items):
    """预算按次递减——不是一次性闸门，否则第二条同类失败条目会永远排不上。"""
    from backend.factory.registry import ServiceRegistry

    await _clear_failed("timeout")
    svc = ServiceRegistry.get().pipeline
    await _mk_item(source_id="b-a", status=ItemStatus.FAILED,
                   error="x", error_class="timeout", retry_count=0)
    await _mk_item(source_id="b-b", status=ItemStatus.FAILED,
                   error="x", error_class="timeout", retry_count=0)

    assert await svc.retry_class("timeout") == 2
    for src in ("b-a", "b-b"):
        async with session_factory() as session:
            row = (await session.execute(
                select(Item).where(Item.source_id == src))).scalar_one()
            assert row.retry_count == 1
            assert row.error_class == ""
