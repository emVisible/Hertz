"""并发上限（v0.37）——从写死字典改成读 settings 之后的契约。

这一项的核心承诺只有一句：**用户改了设置，并发上限真的变**。所以测试重心
不在「默认值是多少」，而在「上限是否可配、非法值是否安全、运行期改动是否生效」。

v0.37 之前 `DEFAULT_LIMITS` 是一份写死的字典，没有任何读取路径——付费 API 配
高额度的用户被锁死在 4 并发，唯一的解法是改源码。那种「看得见却改不了」的
旋钮，正是这一轮要消灭的东西。
"""

import asyncio
from pathlib import Path

import pytest

from backend.config import runtime_config, settings
from backend.factory.concurrency import DEFAULT_LIMITS, ConcurrencyLimiter


@pytest.fixture
def clean_runtime():
    """每个测试用完把 runtime.yaml 恢复原状——否则会污染真实用户配置。"""
    before = dict(runtime_config.load())
    yield
    runtime_config.save(before)


def test_defaults_unchanged_when_user_configures_nothing():
    """什么都不配时行为与改动前完全一致——这是不能破的兼容底线。"""
    limiter = ConcurrencyLimiter()
    assert limiter.limits() == DEFAULT_LIMITS


def test_limits_read_from_settings(clean_runtime):
    runtime_config.save({"concurrency_llm": 12})
    try:
        assert ConcurrencyLimiter().limits()["llm"] == 12
    finally:
        runtime_config.save({})


def test_pinned_limits_win_over_settings(clean_runtime):
    """显式传 limits = 钉死上限（测试与特殊场景），不被 settings 覆盖。"""
    runtime_config.save({"concurrency_llm": 12})
    try:
        assert ConcurrencyLimiter({"llm": 1}).limits() == {"llm": 1}
    finally:
        runtime_config.save({})


@pytest.mark.parametrize(
    ("given", "expected"),
    [
        (0, 1),      # 0 会让信号量永远不放行 → 死锁，钳到 1
        (-5, 1),     # 负数是 asyncio 不接受的
        ("abc", 4),  # 非数字 → 落回该任务族默认值
        (None, 4),
        (8, 8),
    ],
)
def test_illegal_values_fall_back_safely(clean_runtime, given, expected):
    """非法值不能把流水线搞挂。

    并发上限是**保护措施**：用户把它填成 0，正确的反应是降级到 1，不是让整个
    pipeline 死锁。抛异常则更糟——一个保护参数填错导致服务起不来。
    """
    runtime_config.save({"concurrency_llm": given})
    try:
        assert ConcurrencyLimiter().limits()["llm"] == expected
    finally:
        runtime_config.save({})


@pytest.mark.asyncio
async def test_runtime_change_takes_effect_without_restart(clean_runtime):
    """运行期改上限要生效——这正是「构造时读一次」那种写法会破的地方。

    本项目的 settings 是运行期可改的（data/runtime.yaml）。如果在构造函数里把
    上限冻结成信号量，改完设置不生效，就等于用新的假旋钮替换了旧的假旋钮。

    直接量「峰值并发」而不是数进入次数：并发控制的语义就是同时能进几个，
    数次数证明不了上限真的变了。
    """
    limiter = ConcurrencyLimiter()

    async def peak_concurrency(n: int) -> int:
        current = 0
        peak = 0
        lock = asyncio.Lock()

        async def probe() -> None:
            nonlocal current, peak
            async with limiter.slot("llm"):
                async with lock:
                    current += 1
                    peak = max(peak, current)
                await asyncio.sleep(0.02)  # 保持重叠，让并发真的发生
                async with lock:
                    current -= 1

        await asyncio.gather(*[probe() for _ in range(n)])
        return peak

    runtime_config.save({"concurrency_llm": 1})
    try:
        assert await peak_concurrency(5) == 1, "上限 1 时不该有并发"

        # 不重建 limiter、不重启进程——只改配置
        runtime_config.save({"concurrency_llm": 3})
        assert await peak_concurrency(5) == 3, (
            "改了 concurrency_llm=3 之后峰值并发仍不是 3——"
            "说明上限被冻结在构造时，是新的假旋钮"
        )
    finally:
        runtime_config.save({})


@pytest.mark.asyncio
async def test_unknown_kind_gets_its_own_slot():
    """未登记的任务族不该崩——给个 1 的独立信号量，与改动前行为一致。"""
    limiter = ConcurrencyLimiter()
    async with limiter.slot("某种没见过的族"):
        pass


def test_settings_has_a_field_for_every_default_kind():
    """每个任务族都要有对应的 settings 字段——漏一个就是那个族改不了。"""
    for kind in DEFAULT_LIMITS:
        assert hasattr(settings, f"concurrency_{kind}"), f"缺 concurrency_{kind}"

# ---------- KeychainCrypto 必须跟随 settings.data_dir（v0.37） ----------

def test_keychain_fallback_path_follows_settings_data_dir(tmp_path):
    """用户在设置页改 data_dir 后，主密钥回退路径必须跟着走。

    原来 `KeychainCrypto` 读 `os.environ["HERTZ_DATA_DIR"]`，而设置页改的是
    `runtime.yaml` 里的 `data_dir`。两者不同步 → 新目录下找不到 master.key →
    生成新密钥 → 已存的密文全部解不开。**静默的数据损坏**：用户只是换了个存储
    位置，却丢掉了所有 API Key。
    """
    from backend.ai.keychain import KeychainCrypto

    before = dict(runtime_config.load())
    try:
        runtime_config.save({"data_dir": str(tmp_path / "moved")})
        crypto = KeychainCrypto()
        assert crypto._fallback_path == tmp_path / "moved" / "secrets" / "master.key"
    finally:
        runtime_config.save(before)


def test_keychain_explicit_dir_still_wins():
    """显式传参优先于 settings——调用方给了目录就不该被配置覆盖。"""
    from backend.ai.keychain import KeychainCrypto

    before = dict(runtime_config.load())
    try:
        runtime_config.save({"data_dir": "/should/not/win"})
        explicit = KeychainCrypto(Path("/explicit/dir"))
        assert explicit._fallback_path == Path("/explicit/dir/secrets/master.key")
    finally:
        runtime_config.save(before)
