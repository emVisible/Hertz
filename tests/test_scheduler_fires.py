"""定时作业到底有没有被执行（v0.34 D-223）。

起因：查「采集六周没产出」时发现 `/api/metrics` 的 ticks 永远是空的。根因不在采集，
在 `ScheduleManager.add_job`——APScheduler 3.x 只看 `iscoroutinefunction(func)`，
而 7 处注册全写成 `lambda: self._timed(...)`：lambda 不是协程函数，于是它被丢进线程池，
返回的协程没人 await，**作业"执行成功"但什么都没发生**，连报错都没有。

前两条腿必须**双向**：只测 lambda 形状会奖励"把调用点全改成传协程函数"这种绕过；
只测直接传函数则放过了真实出事的那个形状。第三条测的是 registry 注释里承诺的
「tick 失败不拖垮调度器」——在修好之前这句话从来没被验证过，因为作业压根没跑。

后三条测告警本身：修好这一次不等于下次不会再来，所以「进程活着、一条 tick 都没有」
必须变成界面上看得见的东西。缺席断言配了在场对照组（有 tick 不许报）和宽限期对照组
（刚启动不许报），否则告警要么长鸣要么从不响。
"""

import asyncio

import pytest

from backend.factory.scheduler import ScheduleManager


async def _both_shapes() -> dict[str, int]:
    sm = ScheduleManager()
    hits = {"lambda": 0, "direct": 0}

    async def body(kind: str) -> None:
        hits[kind] += 1

    async def direct() -> None:
        hits["direct"] += 1

    # 形状 ①：registry 里那 7 处——返回协程的普通 callable
    sm.add_job("by-lambda", lambda: body("lambda"), trigger="interval", seconds=0.2)
    # 形状 ②：真正的协程函数（调用点哪天改成这种也必须照跑）
    sm.add_job("by-direct", direct, trigger="interval", seconds=0.2)
    sm.start()
    try:
        await asyncio.sleep(1.4)
    finally:
        sm.shutdown()
    return hits


@pytest.mark.asyncio
async def test_lambda_shaped_job_actually_runs_its_body() -> None:
    hits = await _both_shapes()
    assert hits["lambda"] >= 2, f"lambda 形状的作业一次都没执行：{hits}"


@pytest.mark.asyncio
async def test_coroutine_function_shaped_job_also_runs() -> None:
    hits = await _both_shapes()
    assert hits["direct"] >= 2, f"直接传协程函数也不跑了（包装把另一种形状弄坏了）：{hits}"


@pytest.mark.asyncio
async def test_a_failing_tick_does_not_kill_the_scheduler() -> None:
    sm = ScheduleManager()
    calls = {"n": 0}

    async def flaky() -> None:
        calls["n"] += 1
        raise RuntimeError("tick 里炸了")

    sm.add_job("flaky", lambda: flaky(), trigger="interval", seconds=0.2)
    sm.start()
    try:
        await asyncio.sleep(1.2)
    finally:
        sm.shutdown()
    assert calls["n"] >= 2, f"作业失败之后调度器就停了：{calls}"


async def _warnings(monkeypatch, *, uptime_s: int, ticks: list[dict]) -> list[str]:
    from backend.infrastructure import telemetry
    from backend.pipeline.service_queries import QueriesMixin

    monkeypatch.setattr(
        telemetry, "snapshot", lambda: {"uptime_s": uptime_s, "ticks": ticks}
    )
    return await QueriesMixin().supply_warnings()


@pytest.mark.asyncio
async def test_silent_scheduler_is_reported_as_a_supply_warning(monkeypatch) -> None:
    """进程活了一小时、一条 tick 都没有 → 界面必须看到「调度器静默」。"""
    warnings = await _warnings(monkeypatch, uptime_s=3600, ticks=[])
    assert "scheduler_silent" in warnings


@pytest.mark.asyncio
async def test_a_tick_present_silences_the_warning(monkeypatch) -> None:
    """对照组：有 tick 就不许报（否则告警等于长鸣，六周事故照样藏得住）。"""
    warnings = await _warnings(
        monkeypatch, uptime_s=3600, ticks=[{"job": "collect", "ok": True}]
    )
    assert "scheduler_silent" not in warnings


@pytest.mark.asyncio
async def test_the_first_three_minutes_do_not_warn(monkeypatch) -> None:
    """宽限期：刚启动时 1 分钟作业可能确实没轮到，不许误报。"""
    warnings = await _warnings(monkeypatch, uptime_s=60, ticks=[])
    assert "scheduler_silent" not in warnings
