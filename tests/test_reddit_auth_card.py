"""Reddit 凭证必须是「能看见的状态」，不是「有时能用有时不能」。

现状（实测）：`pipeline_reddit_client_id` 为空 → `ensure_reddit_token()` 返回 None
→ v0.3.7 的签名直链兜底从未启用，而界面上没有任何地方说这件事。用户只看到
「下载偶尔 403」。D-190 的四件套就是为这类静默降级立的规矩。

本片只补**可见性**（矩阵条目 + 显示名 + 可 probe 的状态端点），不修 403：
凭证得用户自己去 reddit.com/prefs/apps 建。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.config import settings
from backend.infrastructure import deps
from backend.pipeline.collectors import reddit as reddit_collector

ROOT = Path(__file__).resolve().parents[1]
CARDS_TSX = ROOT / "frontend/src/pages/settings/sections/settingsCards.tsx"


@pytest.fixture(autouse=True)
def _isolated_token_cache(monkeypatch) -> None:
    """`_token_holder` 是模块级进程缓存，跨测试共享。

    本片所有测试都从空缓存开始——否则上一个测试留下的 token 会让「probe 吃不吃
    缓存」这类断言变成测试顺序的函数。monkeypatch.setitem 负责还原。
    """
    monkeypatch.setitem(reddit_collector._token_holder, "token", None)


def _unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")


def _configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "cid")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "sec")


def _stub_oauth(monkeypatch, *, status: int = 200, token: str = "t-fresh") -> list[str]:
    """把 `ensure_reddit_token` 的网络边界换成记录器，返回「真发过几次请求」。

    离线且确定：不发真请求，只记 URL。`_system_proxy` 一并桩掉——它会去问 macOS
    的系统代理设置，那是本机状态，不该混进判据。
    """
    calls: list[str] = []

    class _Resp:
        status_code = status

        def json(self) -> dict:
            return {"access_token": token}

    class _Client:
        def __init__(self, *args, **kwargs) -> None: ...

        async def __aenter__(self) -> object:
            return self

        async def __aexit__(self, *exc) -> bool:
            return False

        async def post(self, url, **kwargs) -> object:
            calls.append(str(url))
            return _Resp()

    class _Ns:
        AsyncClient = _Client

    monkeypatch.setattr(reddit_collector, "httpx", _Ns)
    monkeypatch.setattr(reddit_collector, "_system_proxy", lambda: None)
    return calls


# ---------- 能力矩阵条目（D-190 第 2 件）----------


def test_reddit_auth_card_off_when_unconfigured(monkeypatch) -> None:
    """没配凭证要能说「没配」并且给出路——只说没配等于把人留在原地。"""
    _unconfigured(monkeypatch)
    card = deps._check_reddit_auth()
    assert card["status"] == "off"
    # install_hint 是 DepsCard 非 ok 行唯一渲染的出路字段（status==ok 或无 hint 就不渲染）
    assert "设置" in card["install_hint"]


def test_reddit_auth_card_ok_when_configured(monkeypatch) -> None:
    _configured(monkeypatch)
    assert deps._check_reddit_auth()["status"] == "ok"


@pytest.mark.asyncio
async def test_card_registered_in_matrix_and_rendered(client, monkeypatch) -> None:
    """D-190 四件套里「界面看得见」的两条腿：矩阵有条目 + 显示名与渲染行都在。

    矩阵有条目但 LABELS 没名字 → 界面上是一串裸 key；LABELS 有名字但不在 rows
    里 → 条目压根不被渲染（rows 才是渲染清单）。两种都等于用户看不见。
    """
    _unconfigured(monkeypatch)
    matrix = await deps.check_dependencies()
    assert "reddit_auth" in matrix

    # DepsCard 取的是缓存 GET /api/deps——条目进不了这个响应，界面上就没有这张卡
    await client.post("/api/deps/check")
    assert "reddit_auth" in (await client.get("/api/deps")).json()

    text = CARDS_TSX.read_text(encoding="utf-8")
    labels_src = text[text.index("const LABELS"): text.index("const rows")]
    rows_src = text[text.index("const rows"):]
    assert "reddit_auth:" in labels_src, "能力矩阵有条目但界面无显示名 = 用户永远看不到"
    assert "'reddit_auth'" in rows_src, "有显示名但不在渲染清单里 = 一样不出现"


# ---------- 退化告警：新卡不得刷屏，但配好又掉了必须说 ----------


def test_card_starting_off_is_silent_but_losing_creds_alerts() -> None:
    """`_diff_degradation` 只认 ok→非 ok：从未配过的用户不会每天被推一条「你没配」。

    反过来，填完凭证又被清空（改配置/换机器丢 runtime.yaml）是真退化，要说。
    """
    off = {"reddit_auth": {"status": "off", "detail": "x"}}
    ok = {"reddit_auth": {"status": "ok", "detail": "签名直链兜底已启用"}}
    assert deps._diff_degradation(off, off) == []
    assert deps._diff_degradation(None, off) == []  # 首次建基线不告警
    assert deps._diff_degradation(off, ok) == []
    assert any("reddit_auth" in line for line in deps._diff_degradation(ok, off))


# ---------- 状态端点：填完凭证能自己验，不用去猜 ----------

OFF_HINT = "在 reddit.com/prefs/apps 建 script 应用后填进设置"


def _forbid_network(monkeypatch) -> list[str]:
    """把「有没有真取过 token」变成可断言的记录，而不是靠桩里抛异常。

    旧写法在桩里 `raise AssertionError`——但端点把这个调用整个 try/except 掉了
    （pipeline_ops 的降级腿），AssertionError 作为 Exception 被咽成 token_ok=false，
    真正的保护其实是「token_ok is None」。现在盯调用次数，说法与机制对齐。
    """
    calls: list[str] = []

    async def _record() -> str | None:
        calls.append("ensure_reddit_token")
        return "t-from-network"

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _record)
    return calls


@pytest.mark.asyncio
async def test_status_endpoint_reports_unconfigured_without_network(
    client, monkeypatch
) -> None:
    _unconfigured(monkeypatch)
    calls = _forbid_network(monkeypatch)
    r = await client.get("/api/pipeline/reddit-auth/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "token_ok": None, "hint": OFF_HINT}
    assert calls == [], "默认渲染一次就把 OAuth 打了——用户填没填凭证都不该联网"


@pytest.mark.asyncio
async def test_status_endpoint_needs_opt_in_to_probe(client, monkeypatch) -> None:
    """凭证填好了也不自动联网：只有 probe=true 才真取 token。"""
    _configured(monkeypatch)
    calls = _forbid_network(monkeypatch)
    body = (await client.get("/api/pipeline/reddit-auth/status")).json()
    assert body["configured"] is True
    assert body["token_ok"] is None
    assert body["hint"] == ""
    assert calls == []


@pytest.mark.asyncio
async def test_status_endpoint_probe_true_actually_takes_token(client, monkeypatch) -> None:
    _configured(monkeypatch)

    async def _fake() -> str | None:
        return "t-abc"

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _fake)
    body = (await client.get("/api/pipeline/reddit-auth/status", params={"probe": "true"})).json()
    assert body == {"configured": True, "token_ok": True, "hint": ""}


@pytest.mark.asyncio
async def test_probe_true_refetches_after_credentials_were_edited(client, monkeypatch) -> None:
    """probe 的意义是「我刚填的凭证对不对」——答陈旧缓存就等于答非所问。

    复现形状：之前某次采集成功留下 token → 用户改了凭证 → probe=true。真取会 401
    （桩给 401），旧实现却在 `if _token_holder["token"]: return ...` 处短路，把老
    token 当成功递回去（PATCH /api/config 从不失效它）。
    """
    _configured(monkeypatch)
    monkeypatch.setitem(reddit_collector._token_holder, "token", "stale-from-earlier")
    calls = _stub_oauth(monkeypatch, status=401)
    body = (
        await client.get("/api/pipeline/reddit-auth/status", params={"probe": "true"})
    ).json()
    assert calls, "probe=true 没发过取 token 请求——它回答的是缓存，不是凭证"
    assert body["token_ok"] is False


@pytest.mark.asyncio
async def test_probe_true_exchanges_a_fresh_token_when_cache_is_warm(client, monkeypatch) -> None:
    """另一半：缓存热着也必须重换，否则 probe 永远在复读第一次成功的那个 token。"""
    _configured(monkeypatch)
    monkeypatch.setitem(reddit_collector._token_holder, "token", "stale-from-earlier")
    calls = _stub_oauth(monkeypatch, status=200, token="t-fresh")
    body = (
        await client.get("/api/pipeline/reddit-auth/status", params={"probe": "true"})
    ).json()
    assert body["token_ok"] is True
    assert len(calls) == 1
    assert reddit_collector._token_holder["token"] == "t-fresh"


@pytest.mark.asyncio
async def test_status_endpoint_probe_failure_is_readable_not_500(
    client, monkeypatch
) -> None:
    """填错 secret 时 OAuth 抛 RuntimeError——端点炸成裸 500 等于没说。

    「我问过并且失败」和「我没问」是两件事：前者要退成 token_ok=false + 出路。
    出路文案只报异常类型名（`_verify_reddit_channel` 同文件已有先例）：现在的异常
    文本不含 secret，但「回显 str(exc)」这条通道一旦以后有人把响应体塞进异常，
    前端就读到了——宽度得由这里定，不能由异常作者定。
    """
    _configured(monkeypatch)

    async def _wrong() -> str | None:
        raise RuntimeError(
            "Reddit OAuth 换取 token 失败 (HTTP 401)——client_secret=do-not-echo-me"
        )

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _wrong)
    r = await client.get("/api/pipeline/reddit-auth/status?probe=true")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True and body["token_ok"] is False
    assert "client_id" in body["hint"]
    assert "do-not-echo-me" not in body["hint"]


# ---------- 一份事实一个作者 ----------


def test_configured_judgment_has_a_single_author() -> None:
    """`configured` 判据只写在 `deps.reddit_credentials_configured()` 里。

    端点自己再 `bool(id and secret)` 一遍就是第二个作者——两边对「填了空格算不算」
    的理解迟早漂移，届时矩阵说 ok、端点说没配，用户看到的还是自相矛盾的两行字。
    采集侧是第三个消费者（`ensure_reddit_token` 的准入判断）：它自己那行原始
    `and` 判据曾是第二个作者，所以这里也盯着它。
    文本腿只是围栏——它能被注释满足，也能被注释踩红（本文件的 docstring 因此
    不逐字抄那句判据）。真正的牙齿是下面三条行为腿：把 helper 换脸色，看谁跟。
    """
    router_src = (ROOT / "backend/routers/pipeline_ops.py").read_text(encoding="utf-8")
    assert "reddit_credentials_configured" in router_src, "端点没消费唯一作者，八成是重写了一遍"
    assert "pipeline_reddit_client_secret" not in router_src, "判据在端点里第二次出现"

    collector_src = (ROOT / "backend/pipeline/collectors/reddit.py").read_text(encoding="utf-8")
    assert "reddit_credentials_configured" in collector_src, "采集侧没问 helper，自己数了一遍"
    assert "if not (client_id and client_secret)" not in collector_src, "原始非空判据回来了"


@pytest.mark.asyncio
async def test_collector_agrees_with_the_judgment_on_whitespace_only_creds(
    monkeypatch,
) -> None:
    """id/secret 只填了空格：判据说不算配齐，采集侧就不能自己冲出去换 token。

    两边各数一遍时的可观测分歧就在这儿——空格串在 `if not (client_id and secret)`
    里是真值（照发 OAuth 拿 401），在 `strip()` 判据里是假值（卡片 off）。
    """
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "   ")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "   ")
    calls = _stub_oauth(monkeypatch)
    assert await reddit_collector.ensure_reddit_token() is None
    assert calls == [], "判据没过却已经发了取 token 请求"


@pytest.mark.asyncio
async def test_collector_asks_the_judgment_not_its_own_truthiness(monkeypatch) -> None:
    """把判据本身换成恒 False，采集侧必须跟着停手——即使两个字段看着都正常。

    这条腿连「采集侧抄了一份 strip 版判据」都能红：抄的那份不认识 helper 的脸色。
    """
    _configured(monkeypatch)
    monkeypatch.setattr(deps, "reddit_credentials_configured", lambda *a: False)
    calls = _stub_oauth(monkeypatch)
    assert await reddit_collector.ensure_reddit_token() is None
    assert calls == []


@pytest.mark.asyncio
async def test_status_endpoint_configured_comes_from_the_live_judgment(
    client, monkeypatch
) -> None:
    """端点必须现问 helper：文本腿光看「源码里有没有那个函数名」，注释提一句就过了。

    判据说配齐（helper 换成恒 True）而设置里是空的 → configured 必须是 True。
    漏掉的回归形状是「读缓存矩阵」（`load_dependencies()["reddit_auth"]`，仓里有先例）：
    那种实现里没有一个字段名、也没有那次 import，文本腿全绿，而这条会红——它把陈旧
    性带进了一个自称「现在怎么样」的端点。
    """
    _unconfigured(monkeypatch)
    monkeypatch.setattr(deps, "reddit_credentials_configured", lambda *a: True)
    body = (await client.get("/api/pipeline/reddit-auth/status")).json()
    assert body["configured"] is True


# ---------- 保存凭证 = 一次操作的两半，得互相看见 ----------


@pytest.mark.asyncio
async def test_saving_credentials_refreshes_the_cached_matrix(client) -> None:
    """填完凭证点保存，卡片必须当场变——不该等重启或手点「重新检测」。

    DepsCard 读的是缓存（`GET /api/deps`），今天的刷新触发点是启动预热、手动重测、
    模型下载完成三处，保存凭证一个都不占：主流程（读提示→填字段→保存）结束后芯片
    还停在 off，等于这条可见性只做了一半。reddit_auth 是纯配置读，刷新无需探测。
    同 `pipeline_ops._spawn_model_download` 里那句「同一次操作的两半互相看不见」。
    """
    runtime_yaml = Path(settings.data_dir) / "runtime.yaml"
    keys = ("pipeline_reddit_client_id", "pipeline_reddit_client_secret")
    # monkeypatch.undo 把「原值」当实例属性写回 settings 代理，之后 `__getattr__`
    # 不再回落到 runtime.yaml——读穿被永久屏蔽。本条测的正是真读穿，先把同文件
    # 前面测试留下的残留清掉（否则这条会随测试顺序变绿变红）。
    for key in keys:
        vars(settings).pop(key, None)
    try:
        before = (await client.get("/api/deps")).json()
        assert before["reddit_auth"]["status"] == "off"
        r = await client.patch(
            "/api/config",
            json={"overrides": {keys[0]: "cid", keys[1]: "sec"}},
        )
        assert r.status_code == 200
        after = (await client.get("/api/deps")).json()
        assert after["reddit_auth"]["status"] == "ok", (
            "保存后矩阵还是 off——不重测就不算数，用户只能重启或自己点重新检测"
        )
    finally:
        if runtime_yaml.exists():
            runtime_yaml.unlink()
        for key in keys:
            vars(settings).pop(key, None)
        await deps.refresh_dependencies()  # 缓存回到未配置态，别泄漏给下一个测试


# ---------- 退化告警要跟着真卡片 ----------


def test_degradation_alert_couples_to_the_real_card(monkeypatch) -> None:
    """手搭字典那条守不住「卡片状态字段改名」——这里用真 `_check_reddit_auth()` 跑一遍。

    `_diff_degradation` 只认 ok→非 ok。真实条目哪天不再产出 `status=="ok"`，
    手搭那份照样绿（它自己写的字典），告警腿却已经哑了。
    """
    _configured(monkeypatch)
    ok_card = deps._check_reddit_auth()
    _unconfigured(monkeypatch)
    off_card = deps._check_reddit_auth()
    assert any(
        "reddit_auth" in line
        for line in deps._diff_degradation({"reddit_auth": ok_card}, {"reddit_auth": off_card})
    )
    assert deps._diff_degradation({"reddit_auth": off_card}, {"reddit_auth": off_card}) == []


def test_card_delegates_to_the_shared_judgment(monkeypatch) -> None:
    """矩阵条目也必须走同一个 helper，而不是自己再数一遍字段。"""
    monkeypatch.setattr(deps, "reddit_credentials_configured", lambda *a: True)
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")
    assert deps._check_reddit_auth()["status"] == "ok"

