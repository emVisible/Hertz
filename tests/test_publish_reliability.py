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

from backend.models.pipeline import ResourceCooldown
from backend.models.session import session_factory
from backend.pipeline.publish_reliability import (
    COOLDOWN_PREFIX,
    PublishThrottledError,
    backoff_seconds,
    clear_cooldown,
    cooldown_domain,
    cooldown_left,
    is_retryable,
    publish_with_retry,
    trip_cooldown,
)


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
    from backend.pipeline.publishers.router import PUBLISHERS

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