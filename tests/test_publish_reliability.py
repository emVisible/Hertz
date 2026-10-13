"""发布可靠性（v0.38）：重试 + 限速熔断。

这一层守护的是**链路的终点**。此前 `service_publish` 全文没有
retry/backoff/sleep——一次网络抖动 = 一次已经被消费掉的调度槽位。

测试重点在三件事上，它们都是「错了不会报错、只会悄悄变坏」的类型：

1. **永久性失败不重试**——403/404 是 cookie 过期，重试一万次还是同一结果
2. **被限流时标 FAILED 是错的**——条目没坏，只是现在发不出去
3. **退避递增且有上限**——无限退避会把整个 tick 堵死
"""

from __future__ import annotations

from uuid import UUID, uuid4

import pytest
from sqlalchemy import select

from backend.config import runtime_config
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
    # v0.39：判重命中改抛 DuplicateContentError（409 冲突），不再是 ValueError。
    # 断言文案里必须带上「重复」——文案是这个错误唯一会被人看到的东西。
    from backend.pipeline.dedupe import DuplicateContentError

    with pytest.raises(DuplicateContentError, match="重复投稿"):
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
    # v0.39：闸门抽进 `_assert_not_duplicate`，函数名也换成了带命中项的
    # `*_match` 版本（返回撞上了哪条，而不是一个 bool）。守卫跟着改名，
    # 它要护的**性质**没变。
    title_gate = src.index("find_published_title_match")
    phash_gate = src.index("find_phash_match")
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


def _uniq(prefix: str) -> str:
    """每次运行都不重名的标题。

    发布期标题指纹闸会扫**全库**的 PUBLISHED 行（那正是「重复投稿」成立的
    范围）。共享测试库里别的文件漏下的已发布行会撞上固定标题——于是这条测试
    在单跑时绿、全量时红，且红的原因与被测行为无关。唯一的标题把这种
    交叉污染从判据里彻底移除。
    """
    return f"{prefix} {uuid4().hex[:12]}"


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


@pytest.mark.asyncio
async def test_failure_distribution_counts_publish_only(client, clean_items):
    """`failures_7d_by_class` 只能装发布失败——它挂在「发布状态」上。

    `error_class` 是全流程共享的列：下载、ffmpeg、tts 的失败同样写进去。
    不加限定，界面上的「近 7 天发布失败」会报出「视频处理失败 ×4」——
    一个会说谎的指标比没有指标更糟，它让人去查错的方向。
    """

    async with session_factory() as session:
        # 制作阶段挂掉的 ffmpeg：error 没有发布前缀，只有它该被排除
        session.add(Item(
            source="test", item_type="text_only", title="非发布失败",
            status=ItemStatus.FAILED, error_class="ffmpeg",
            error="ffmpeg exited 1 while rendering",
        ))
        session.add(Item(
            source="test", item_type="text_only", title="真发布失败",
            status=ItemStatus.FAILED, error_class="blocked",
            error="auto publish failed: HTTP Error 403: Forbidden",
        ))
        await session.commit()

    body = (await client.get("/api/pipeline/publish/status")).json()
    dist = body["failures_7d_by_class"]
    assert dist.get("blocked") == 1
    assert "ffmpeg" not in dist, (
        f"非发布阶段的失败混进了发布失败分布：{dist}"
    )


# ---------- 判重命中是「跳过」，不是「发布失败」（v0.39） ----------

@pytest.mark.asyncio
async def test_auto_publish_duplicate_is_skipped_not_failed(clean_items):
    """用户报的现象：从未发布过的内容被提示「发布失败：duplicate detected」。

    判重命中是**系统的正确裁决**——不投稿就是对的。把它记成 FAILED 会同时
    骗过四处：条目状态、失败看板、失败分类分布、重试预算。而重试预算花在这
    上尤其荒谬：闸的结论是**确定性**的，重试一万次还是同一条近源成片。
    """
    from datetime import UTC, datetime, timedelta

    from backend.factory.registry import ServiceRegistry
    from backend.pipeline.publish_queue import PHASE_READY

    svc = ServiceRegistry.get().pipeline
    before = dict(runtime_config.load())
    try:
        runtime_config.save({
            "pipeline_auto_publish": True,
            "pipeline_auto_promote_daily": 0,
            "pipeline_auto_publish_daily_limit": 10,
        })
        # 画面闸：待发布条目**自己也要有 phash**，否则闸根本走不到
        await _mk_item(source_id="dup-pub", status=ItemStatus.PUBLISHED,
                       title=_uniq("已发布的原片"), phash="a1b2c3d4e5f60718")
        dup = await _mk_item(
            source_id="dup-new", status=ItemStatus.APPROVED, title=_uniq("近源新片"),
            phash="a1b2c3d4e5f60718",
            scheduled_at=datetime.now(UTC) - timedelta(minutes=1),
        )
        await svc.enqueue(UUID(dup), PHASE_READY)

        result = await svc.auto_publish_tick()

        assert result["failed"] == 0, "判重不是失败"
        assert result["skipped"] == 1, f"应记为跳过，实际 {result}"

        async with session_factory() as session:
            row = (await session.execute(
                select(Item).where(Item.source_id == "dup-new"))).scalar_one()
            assert row.status == ItemStatus.SKIPPED, f"实际 {row.status}"
            assert row.retry_count == 0, "确定性判定不该消耗重试预算"
            assert row.error_class == "", "不是失败分类，不该进失败看板"

        # 关键：它不会再被 due 查询捞起（只捞 APPROVED），所以下一轮不会重复处理
        result2 = await svc.auto_publish_tick()
        assert result2["skipped"] == 0, "跳过的条目不该被反复捞起"
    finally:
        runtime_config.save(before)


@pytest.mark.asyncio
async def test_duplicate_publish_returns_409_not_502(client, clean_items):
    """手动点发布撞判重：409 冲突，不是 502「发布失败」。

    他从未上传过任何东西。502 会让界面把这件事显示成红色故障，并诱导用户
    去查 cookie、检查网络、重试——而正确答案是「这条和已发布的内容重复」。
    """
    await _mk_item(source_id="dup-pub2", status=ItemStatus.PUBLISHED,
                   title=_uniq("原片二"), phash="0123456789abcdef")
    iid = await _mk_item(source_id="dup-new2", status=ItemStatus.APPROVED,
                         title=_uniq("新片二"), phash="0123456789abcdef")

    r = await client.post(f"/api/pipeline/items/{iid}/publish")
    assert r.status_code == 409, f"判重应是 409 冲突，实际 {r.status_code} {r.text[:120]}"
    body = r.json()
    assert body.get("code") == "duplicate_content"

    # 条目落终态 skipped，且不占重试预算
    async with session_factory() as session:
        row = (await session.execute(
            select(Item).where(Item.source_id == "dup-new2"))).scalar_one()
        assert row.status == ItemStatus.SKIPPED, f"实际 {row.status}"
        assert row.retry_count == 0, "确定性判定不该消耗重试预算"
        assert row.error_class == "", "不是失败分类，不该进失败看板"


@pytest.mark.asyncio
async def test_skipped_item_absent_from_failure_board(client, clean_items):
    """跳过不得出现在失败分类分布里——那正是「为什么发不出去」的答案位。"""

    await _mk_item(source_id="dup-pub3", status=ItemStatus.PUBLISHED,
                   title=_uniq("原片三"), phash="aaaabbbbccccdddd")
    iid = await _mk_item(source_id="dup-new3", status=ItemStatus.APPROVED,
                         title=_uniq("新片三"), phash="aaaabbbbccccdddd")
    await client.post(f"/api/pipeline/items/{iid}/publish")

    # 对着**真实**出口断言（先前写成 `/board?view=exceptions`，而那条路由根本
    # 不存在——断言因此恒真，是条假绿测试）。
    counts = (await client.get("/api/pipeline/failures")).json()
    assert "publish" not in counts, f"跳过混进了失败分类看板：{counts}"

    failed_items = (await client.get("/api/pipeline/items?status=failed&limit=100")).json()
    assert not any(i.get("source_id") == "dup-new3" for i in failed_items), \
        "跳过的条目被当成失败条目列了出来"

    # 但它必须**看得见**——静默消失和谎报失败一样，都是把真相藏起来。
    skipped_items = (await client.get("/api/pipeline/items?status=skipped&limit=100")).json()
    assert any(i.get("source_id") == "dup-new3" for i in skipped_items), \
        "跳过的条目无处可查：它既不是失败，也没出现在任何地方"


@pytest.mark.asyncio
async def test_force_overrides_duplicate_gate(client, clean_items):
    """误判要有人能推翻：phash 容差会把画面相近但不同的两条判成重复。

    没有出口时，误判等于永久失去这条内容——用户只能看着它卡住，且系统
    反复告诉他「这是重复」。`force=1` 是**人的**决定。
    """

    await _mk_item(source_id="dup-pub4", status=ItemStatus.PUBLISHED,
                   title=_uniq("原片四"), phash="1111222233334444")
    iid = await _mk_item(source_id="dup-new4", status=ItemStatus.APPROVED,
                         title=_uniq("新片四"), phash="1111222233334444")

    r = await client.post(f"/api/pipeline/items/{iid}/publish?force=1")
    assert r.status_code == 200, f"force 应放行，实际 {r.status_code} {r.text[:120]}"
    async with session_factory() as session:
        row = (await session.execute(
            select(Item).where(Item.source_id == "dup-new4"))).scalar_one()
        assert row.status == ItemStatus.PUBLISHED


@pytest.mark.asyncio
async def test_force_publish_from_skipped_state(client, clean_items):
    """跳过是终态，但 force 要能从**那个状态**发起——否则出口只存在于文档里。

    误判发生时，条目已经在 `skipped`。若 force 只接受 APPROVED，用户看到的
    就是一个关不掉的死结：内容被挡住，而「仍然发布」按钮永远报错。
    """
    from backend.models.item import Item, ItemStatus

    await _mk_item(source_id="dup-pub5", status=ItemStatus.PUBLISHED,
                   title=_uniq("原片五"), phash="5555666677778888")
    iid = await _mk_item(source_id="dup-new5", status=ItemStatus.APPROVED,
                         title=_uniq("新片五"), phash="5555666677778888")

    assert (await client.post(f"/api/pipeline/items/{iid}/publish")).status_code == 409
    r = await client.post(f"/api/pipeline/items/{iid}/publish?force=1")
    assert r.status_code == 200, f"跳过态应能强制发布，实际 {r.status_code} {r.text[:120]}"
    async with session_factory() as session:
        row = (await session.execute(
            select(Item).where(Item.source_id == "dup-new5"))).scalar_one()
        assert row.status == ItemStatus.PUBLISHED


@pytest.mark.asyncio
async def test_force_does_not_resurrect_rejected_or_failed(clean_items):
    """force 只放行「判重跳过」，不该顺手复活其它终态。

    FAILED 的问题不是重复（可能是 cookie 过期），REJECTED 是人的决定。
    一个「什么都能强推」的开关等于没有状态机。
    """
    from backend.errors import HertzError
    from backend.factory.registry import ServiceRegistry

    svc = ServiceRegistry.get().pipeline
    for src, st in (("force-rej", "rejected"), ("force-fail", "failed")):
        iid = await _mk_item(source_id=src, status=st, title=_uniq(src))
        with pytest.raises(HertzError):
            await svc.publish_one(UUID(iid), force=True)
