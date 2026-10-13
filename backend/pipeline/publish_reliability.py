"""发布可靠性：瞬时失败重试 + 发布侧限速熔断（v0.38）。

## 为什么要有这一层

此前 `service_publish` 全文没有 `retry` / `backoff` / `sleep`。一次网络抖动
的后果不是「延迟一下」，而是：

```
调度引擎已经把「今晚 19:30 发这条」算好 → 槽位被标记消费 → biliup 上传失败
→ 条目标 FAILED → 没有任何东西会补发 → 那天的发布窗口直接损失
```

也就是说，**链路的终点是一次性的、且没有记忆**。这条流水线前面有采集冷却、
CDN 熔断、账号健康度四相位，唯独终点这一环是裸的。

## 只重试「瞬时」失败

重试不是越多越好——对永久性失败重试是纯浪费，而且会加重对方的封禁：

| 失败类别 | 重试？ | 理由 |
|---|---|---|
| `rate_limit` / `timeout` | ✅ | 对方暂时不接受，等一会儿就好 |
| 网络类（DNS/连接重置） | ✅ | 同上 |
| `blocked`（403/404/405） | ❌ | cookie 过期或权限不足，重试一万次也是同样结果 |
| 值错误 / 状态非法 | ❌ | 我们的数据错了，重试不改变任何事 |
| `internal` | ⚠️ | 未知错误重试一次，但只一次（见 `RETRYABLE_CLASSES` 之外的兜底） |

## 限速熔断复用 `ResourceCooldown`

下载侧早就有一张 `resource_cooldown` 表（按媒体域冻结下载）。**不新建表**——
发布侧限速用同一个机制，域名前缀 `publish:<target>`。理由：两件事的形状完全
相同（某目标连续失败 → 冻结一段时间 → 成功即解冻 → 指数退避），而「新建一张
几乎一样的表」正是本仓反复出现的第二真相源来源。

## 关键设计：限速期间**不**标 FAILED

被限流时把条目标成 FAILED 是错的——它没坏，只是现在发不出去。调用方
（自动发布 tick）收到 `PublishThrottledError` 后应当**跳过**而不是标失败，
下一个 tick 自然会重试。把它标 FAILED 会让「今天还有几条没发出去」这个
最该被回答的问题失去答案。
"""

from __future__ import annotations

import asyncio
import logging
import time

from backend.config import settings
from backend.models.pipeline import ResourceCooldown

logger = logging.getLogger(__name__)

#: 发布侧冷却的域名前缀。复用下载侧那张表，用前缀区分用途。
COOLDOWN_PREFIX = "publish:"

#: 值得重试的失败类别（`errors.classify_error` 的取值）。
#:
#: 注意 **`publish` / `other` 不在其中**。这两个在分类器里是**兜底桶**：任何
#: 拿不准的文本都掉进去（含「片段没有原始媒体文件」「状态非法」这类我们自己的
#: 数据错误）。对看板聚合来说「归到 publish 堆里」是可接受的，对**重试决策**
#: 来说不行——那会把我们自己的数据错误重试三遍，然后照样失败，只是慢了 35 秒。
#:
#: 真正的发布侧传输故障（连接被拒/超时/SSL）由下面的 `_NETWORK_HINTS` 覆盖，
#: 不依赖分类器。
RETRYABLE_CLASSES = frozenset({"rate_limit", "timeout"})

#: 我们自己的数据/状态错误——重试一万次也是同一结果。
#:
#: 这些文本在发布语境下比在采集语境下更常见（发布是唯一会把「成片有问题」
#: 暴露给用户的一步），显式列出来是为了让意图可见：它们**故意**不重试。
PERMANENT_HINTS = (
    "duplicate detected",       # 发布期查重命中——正是 B 闸要拦的
    "不能作为片段", "没有原始媒体文件",
    "cannot publish item in state", "invalid_item_state",
    "片段不存在", "片段尚未下载",
    "must be one of",           # publisher 收到不认识的 target
)

#: 文本级判定：网络层错误常常没有可归类的 error_class，只能看原文。
#:
#: 这些判据**优先于** `classify_error`，因为那个分类器是为「失败看板聚合」
#: 设计的，在发布语境下有两个会误判的形状（实测）：
#:
#: - `Connection refused` 命中它的 refused 关键词，被归为 blocked 而不重试。
#:   而连接被拒是本机没起服务/瞬时抖动，正是最该重试的一类。
#: - `command timed out` 被归为 ffmpeg（采集阶段的语义）而���重试。
#:
#: 分类器没错，错的是把它跨阶段复用——它的类别是给**看板**看的，不是给
#: **重试决策**看的。重试要回答的是「等一会儿会不会好」，分类器答的是「归哪堆」。
_NETWORK_HINTS = (
    "connection reset", "connection refused", "connection aborted",
    "temporary failure in name resolution", "name or service not known",
    "network is unreachable", "eof occurred", "broken pipe",
    "ssl", "timed out", "timeout", "temporarily unavailable",
)


class PublishThrottledError(RuntimeError):
    """目标处于限速冷却中，本次不尝试发布。

    调用方**不应**把它当失败：条目没坏，只是现在发不出去。自动发布 tick 收到
    它就该跳过，等下一个 tick 再来。
    """


def cooldown_domain(target: str) -> str:
    return f"{COOLDOWN_PREFIX}{target}"


def is_retryable(error: BaseException | str) -> bool:
    """这个失败值得再试一次吗？

    从 `errors.classify_error`（若能 import）取类别，取不到就退回文本判定。
    两条路都判不出来时**保守地不重试**——对永久性失败重试是纯浪费。
    """
    text = str(error).lower()
    # 永久性先判：显式清单优先于一切启发式，否则下面的兜底会把它们捞回来
    if any(h in text for h in PERMANENT_HINTS):
        return False
    # 网络层特征次之——见 _NETWORK_HINTS 处的说明
    if any(h in text for h in _NETWORK_HINTS):
        return True
    try:
        from backend.pipeline.errors import classify_error

        klass = classify_error(text)
    except Exception:  # noqa: BLE001 — 分类器不该成为发布的单点故障
        return False
    return klass in RETRYABLE_CLASSES


def backoff_seconds(attempt: int, *, base: float | None = None) -> float:
    """第 `attempt` 次失败后等多久（attempt 从 1 起）。

    指数退避：5s → 10s → 20s。上限 60s 封顶——再长就该交给下一个 tick 了，
    在一次 tick 里阻塞太久会让整轮发布都停摆。
    """
    b = float(base if base is not None else getattr(
        settings, "pipeline_publish_retry_base_seconds", 5.0))
    return min(b * (2 ** max(0, attempt - 1)), 60.0)


# ---------- 限速熔断（落库，重启不丢） ----------

async def cooldown_left(target: str, *, now: float | None = None) -> float:
    """该目标还剩多少秒冷却；0 = 可以发。"""
    from sqlalchemy import select

    from backend.models.session import session_factory

    t = time.time() if now is None else now
    async with session_factory() as session:
        row = (await session.execute(
            select(ResourceCooldown).where(
                ResourceCooldown.domain == cooldown_domain(target))
        )).scalar_one_or_none()
        if row is None:
            return 0.0
        return max(0.0, float(row.until_epoch) - t)


async def trip_cooldown(target: str, *, now: float | None = None) -> float:
    """命中限速 → 冻结该目标的发布，返回冻结秒数。

    退避阶梯随连续失败次数增长（有上限），任一次成功发布即解冻——
    「连着撞了三次」比「撞了一次」该等更久，这是熔断的标准形状。
    """
    from sqlalchemy import select

    from backend.models.session import session_factory

    t = time.time() if now is None else now
    base = float(getattr(settings, "pipeline_publish_cooldown_seconds", 900))
    cap = float(getattr(settings, "pipeline_publish_cooldown_max_seconds", 3600))
    domain = cooldown_domain(target)

    async with session_factory() as session:
        row = (await session.execute(
            select(ResourceCooldown).where(ResourceCooldown.domain == domain)
        )).scalar_one_or_none()
        level = 1 if row is None else int(row.fail_level) + 1
        seconds = min(base * (2 ** (level - 1)), cap)
        if row is None:
            row = ResourceCooldown(domain=domain, fail_level=level)
            session.add(row)
        else:
            row.fail_level = level
        row.until_epoch = t + seconds
        await session.commit()
    logger.warning(
        "publish target %s rate-limited, cooling down %.0fs (level %d)",
        target, seconds, level,
    )
    return seconds


async def clear_cooldown(target: str) -> None:
    """一次成功发布即解冻——和下载侧「任一下载成功即解冻」同一形状。"""
    from sqlalchemy import delete

    from backend.models.session import session_factory

    async with session_factory() as session:
        await session.execute(
            delete(ResourceCooldown).where(
                ResourceCooldown.domain == cooldown_domain(target)))
        await session.commit()


# ---------- 重试执行 ----------

async def publish_with_retry(publish, *, target: str, sleep=asyncio.sleep):
    """执行发布，瞬时失败按指数退避重试。

    `publish` 是零参异步 callable，返回 publisher 的结果字典。

    返回 `(result, attempts)`。全部尝试失败则抛出**最后一次**异常——
    上层看到的是真实失败原因，不是「重试了 N 次」这种没信息量的包装。

    限速类失败会顺手 `trip_cooldown`：**重试到限额速还不行时，这条记忆要让
    后续发布也停下来**，否则下一个 tick 会拿同一条去继续撞。
    """
    max_attempts = max(1, int(getattr(settings, "pipeline_publish_max_attempts", 3)))
    last: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            result = await publish()
        except Exception as exc:  # noqa: BLE001 — 分类后决定是否重试
            last = exc
            if not is_retryable(exc):
                raise
            if attempt >= max_attempts:
                # 用文本判定限流（分类器在部分路径拿不到 error_class）
                if "429" in str(exc) or "rate limit" in str(exc).lower():
                    await trip_cooldown(target)
                raise
            delay = backoff_seconds(attempt)
            logger.info(
                "publish to %s failed (%s), retry %d/%d in %.0fs",
                target, exc, attempt, max_attempts, delay,
            )
            await sleep(delay)
            continue
        await clear_cooldown(target)
        return result, attempt
    # 循环必然以 return 或 raise 结束；这里只为类型收敛
    raise last if last else RuntimeError("publish_with_retry exhausted")  # pragma: no cover