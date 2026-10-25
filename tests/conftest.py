"""Shared pytest fixtures: async app client against a dedicated test database.

Tests run against ``hertz_test`` (created on demand, schema rebuilt every
session) so the development database is never polluted and leftover rows
from a previous run cannot leak into assertions.
"""

import asyncio
import os

# Must happen before any `backend.*` import: the engine binds to the URL
# present in the environment at import time.
os.environ.setdefault(
    "HERTZ_DATABASE_URL", "postgresql+asyncpg://hertz:hertz@localhost:5432/hertz_test"
)

# 测试数据根隔离（v0.8.8，AXIOM 34）：必须与数据库同批注入——
# FileStore/LogManager 在 import 期锚定 settings.data_dir，若指向真实 data/，
# 测试会改写 deps.json/hertz.log 甚至覆盖真实成片（final.mp4 被测试条目覆盖过）
#
# ⚠️ log_dir 必须**跟着 data_dir 走**（config.py 里 log_dir 默认 `data/logs`）：
# 它此前是 cwd 相对的裸 `logs/`，与 data_dir 无关，于是这条 setdefault 根本没管到
# 日志——全量测试会把夹具文本写进仓库的 logs/hertz.log（实测 77 行，含一行带
# 密钥字样的 fixture）。改这里时要确认 config.py 的 log_dir 默认值没被改回去。
import tempfile  # noqa: E402

_TEST_ROOT = tempfile.mkdtemp(prefix="hertz-test-data-")
os.environ.setdefault("HERTZ_DATA_DIR", os.path.join(_TEST_ROOT, "data"))
# 显式兜底：万一有人把 log_dir 改回 cwd 相对路径，测试也不该写进仓库
os.environ.setdefault("HERTZ_LOG_DIR", os.path.join(_TEST_ROOT, "logs"))

# 测试环境默认关闭启发式评分：LLM 打分路径测试需走完整链路；
# 启发式有独立测试文件（test_heuristic_score.py）覆盖
os.environ.setdefault("HERTZ_PIPELINE_HEURISTIC_SCORING", "False")

# Pipeline download step: allow loopback test servers (SSRF guard is
# on by default; tests opt out explicitly — AXIOM §8.1).
os.environ.setdefault("HERTZ_PIPELINE_ALLOW_LOOPBACK_URLS", "1")

import pytest  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from backend.main import app  # noqa: E402


def _prepare_database() -> None:
    """Create the test database if missing and rebuild the schema."""
    import sqlalchemy as sa
    from sqlalchemy.ext.asyncio import create_async_engine

    admin = create_async_engine(
        "postgresql+asyncpg://hertz:hertz@localhost:5432/postgres", isolation_level="AUTOCOMMIT"
    )

    async def _run() -> None:
        try:
            async with admin.connect() as conn:
                exists = await conn.scalar(
                    sa.text("SELECT 1 FROM pg_database WHERE datname = 'hertz_test'")
                )
                if not exists:
                    await conn.execute(sa.text("CREATE DATABASE hertz_test"))

            import backend.models  # noqa: F401 — register every table on Base.metadata
            from backend.database import engine
            from backend.models.base import Base

            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.drop_all)
                await conn.run_sync(Base.metadata.create_all)
        finally:
            await admin.dispose()
            await engine.dispose()

    asyncio.run(_run())


@pytest.fixture(scope="session", autouse=True)
def _test_database():
    _prepare_database()
    yield


@pytest.fixture(autouse=True)
async def _clear_collect_cooldown():
    """每个测试**开始前**清掉采集冷却（v0.37）。

    ## 病灶

    `SourceState` 表里的 `cooldown_until` 是**持久**的：某个测试让 BeAmazed
    采集失败，引擎写入 900 秒冷却，之后**所有**测试都打不出
    `[collect] BeAmazed cooling down (896s left)`，采到 0 条。

    ## 症状

    `test_chain_text_story_to_queued` 90 秒超时，报「story-1 未在超时内进入
    审核队列」。实际 story-1 在任何状态里都不存在——它**根本没被采集**。
    日志里那句 `cooling down (896s left)` 距离报错隔着几十万行输出，
    而且它长得像一条正常日志，不查根本不会注意到。

    为什么之前没炸：这条测试单跑通过（干净库无冷却），与前面的测试组合才炸。
    而「哪条测试写了冷却」又取决于执行顺序——典型的顺序依赖型幽灵。
    """
    # 必须在 setup 而不是 teardown：teardown 阶段 pytest-asyncio 已经把事件
    # 循环关掉了，此时再碰 asyncpg 连接会抛
    # "attached to a different loop" —— 报出来的错与冷却毫无关系，更难查。
    from sqlalchemy import delete

    from backend.models.pipeline import SourceState
    from backend.models.session import session_factory

    async with session_factory() as session:
        await session.execute(delete(SourceState))
        await session.commit()
    yield


@pytest.fixture
async def client() -> AsyncClient:
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


@pytest.fixture(autouse=True)
async def _dispose_engine():
    """Drop pooled asyncpg connections after every test.

    Each test runs in a fresh event loop; the module-level engine must not
    carry loop-bound connections across tests (asyncpg raises "attached to
    a different loop" otherwise).
    """
    yield
    from backend.database import engine

    await engine.dispose()


@pytest.fixture(autouse=True)
def _reset_pipeline_state():
    """v0.10.1 异步队列：后台任务跨测试泄漏防护。

    run_batch 现在 create_task 后台执行——前一个测试结束时任务随旧 loop
    被取消（CancelledError → FAILED job 落库），残留 _task/_current_job
    会污染下一个测试（409 busy / jobs 出现 failed）。每个测试开始前重置
    单例状态；旧 loop 的 task 不可 cancel（loop 已关），直接丢引用。
    """
    from backend.factory.registry import ServiceRegistry

    # 采集/发布/Telegram/体检的节流时间戳同样挂在**进程级单例**上
    #（registry.py 的 `_last_auto_collect` 等四个）。它们不是「pipeline 的
    # 后台任务状态」，但后果一样：前一个测试跑过一次 tick，下一个测试立刻
    # 撞上 30 分钟间隔未到而直接跳过。
    #
    # 症状极隐蔽：`test_auto_collect_tick_calls_collect` 单跑通过、串跑报
    # `assert 0 == 1`——因为 `calls["n"]` 是 0，tick 根本没被调用，
    # 而报错的行离真正的原因隔了整条文件。
    #
    # 这个 fixture 本来就负责「单例状态跨测试泄漏防护」，节流时间戳属于同一类。
    for attr in ("_last_auto_collect", "_last_auto_publish", "_last_tg_push", "_last_integrity"):
        setattr(ServiceRegistry.get(), attr, 0.0)

    yield
    pipe = ServiceRegistry.get().pipeline
    pipe._task = None
    pipe._current_job = None


# ---------- 网络隔离（v0.37） ----------

def pytest_addoption(parser):
    parser.addoption("--tb-no-block", action="store_true", default=False,
                     help="临时关闭出站网络阻断（诊断用）")


@pytest.fixture(autouse=True)
def _block_real_network(request, monkeypatch):
    """默认阻断**出站**网络，但放行测试自造的传输层。

    ## 要解决什么

    `test_pipeline_governance.py` 单跑 13 秒通过、串跑却挂死在第 79 条
    （`test_download_one_endpoint` 向 `v.redd.it` 发真实下载请求）。
    faulthandler 抓到的事件循环栈停在 `select`——等一个永不返回的 I/O。
    挂死点与肇事者相隔几十条，看起来像玄学，但它确实是「测试间污染」。

    ## 为什么按标记放行，而不是全局拦 httpx

    第一版我 monkeypatch 了 `httpx.AsyncHTTPTransport.handle_async_request`，
    结果**打伤了 3 个不相干的测试**：它们不走 httpx，而是自己造传输层
    （ASGITransport 之类）跑业务逻辑，被我拦下后静默走了另一条分支
    （下载回落到 yt-dlp），于是一个变量没被赋值，报出一个
    `UnboundLocalError` —— 与网络毫无关系的错，极难定位。

    教训很具体：**全局劫持第三方库的传输层，伤的往往是那些正确地绕开了它的测试**。
    所以改成显式 opt-out：默认阻断，需要真实网络的测试自己声明 `allow_network`；
    本仓目前没有测试真需要它（governance 那条可以改成不打真网）。
    """
    if "allow_network" in request.fixturenames or request.config.getoption("--tb-no-block"):
        yield
        return
    try:
        import httpx
    except ImportError:  # pragma: no cover
        yield
        return

    from backend.infrastructure.net import is_loopback_url

    original_async = httpx.AsyncHTTPTransport.handle_async_request

    async def _blocked(self, request):
        # 回环放行：测试自己起的本地 HTTP 服务（test_download_api 就是这么
        # 造 `http://127.0.0.1:<port>/media.mp4` 的）是**被测对象的一部分**，
        # 堵掉它等于把测试自己的夹具当成外部流量拦下——第一版就是这么打伤了
        # 3 个不相干的测试。
        #
        # 判定复用 `infrastructure.net.is_loopback_url` 而不是自己写字符串判断：
        # 该函数的 docstring 记着一条教训——`"127." in host` 会把
        # `127.0.0.1.example.com` 这种外部域名误判成回环，测试里当场抓到过。
        # 这里再抄一份就会重犯同一个错。
        if is_loopback_url(str(request.url)):
            return await original_async(self, request)
        raise httpx.ConnectError(
            f"出站网络在测试中被默认阻断（{request.url}）。"
            "回环地址放行；确需真实网络请声明 allow_network fixture。"
        )

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _blocked)
    yield


@pytest.fixture
def allow_network():
    """显式放行真实网络（默认阻断）。"""
    yield


@pytest.fixture()
def stub_font_subset(monkeypatch):
    """替身字体子集化：写占位 woff2，不跑 17.8MB NotoSansSC VF 的真子集。

    实测单次真子集 **4.8s 纯 Python CPU**（TTFont 加载 + VF 实例化 + CJK 子集化），
    而 monoline 端到端里**每次改文本的请求**都触发一次——api/recompose/service
    的端到端不消费 woff2 内容（FakeHF 不读字体），真子集的正确性由
    test_monoline_assets 独立守护。需要真子集的测试不要引这个 fixture。
    """
    from backend.monoline import subset as subset_mod
    from backend.monoline.subset import SubsetResult

    def _fake(glyphs, out_path, **kwargs):
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"stub-woff2")
        return SubsetResult(out_path, len(glyphs), out_path.stat().st_size, [], cached=False)

    monkeypatch.setattr(subset_mod, "subset_font", _fake)
    yield
