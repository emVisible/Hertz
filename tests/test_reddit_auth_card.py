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

ROOT = Path(__file__).resolve().parents[1]
CARDS_TSX = ROOT / "frontend/src/pages/settings/sections/settingsCards.tsx"


def _unconfigured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")


def _configured(monkeypatch) -> None:
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "cid")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "sec")


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


def _forbid_network(monkeypatch) -> None:
    """任何一次真取 token 都算失败：设置页每次渲染都打这个端点，不能顺手联网。"""

    async def _boom() -> str | None:
        raise AssertionError("reddit-auth/status 默认不得调 ensure_reddit_token")

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _boom)


@pytest.mark.asyncio
async def test_status_endpoint_reports_unconfigured_without_network(
    client, monkeypatch
) -> None:
    _unconfigured(monkeypatch)
    _forbid_network(monkeypatch)
    r = await client.get("/api/pipeline/reddit-auth/status")
    assert r.status_code == 200
    assert r.json() == {"configured": False, "token_ok": None, "hint": OFF_HINT}


@pytest.mark.asyncio
async def test_status_endpoint_needs_opt_in_to_probe(client, monkeypatch) -> None:
    """凭证填好了也不自动联网：只有 probe=true 才真取 token。"""
    _configured(monkeypatch)
    _forbid_network(monkeypatch)
    body = (await client.get("/api/pipeline/reddit-auth/status")).json()
    assert body["configured"] is True
    assert body["token_ok"] is None
    assert body["hint"] == ""


@pytest.mark.asyncio
async def test_status_endpoint_probe_true_actually_takes_token(client, monkeypatch) -> None:
    _configured(monkeypatch)

    async def _fake() -> str | None:
        return "t-abc"

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _fake)
    body = (await client.get("/api/pipeline/reddit-auth/status", params={"probe": "true"})).json()
    assert body == {"configured": True, "token_ok": True, "hint": ""}


@pytest.mark.asyncio
async def test_status_endpoint_probe_failure_is_readable_not_500(
    client, monkeypatch
) -> None:
    """填错 secret 时 OAuth 抛 RuntimeError——端点炸成裸 500 等于没说。

    「我问过并且失败」和「我没问」是两件事：前者要退成 token_ok=false + 出路。
    """
    _configured(monkeypatch)

    async def _wrong() -> str | None:
        raise RuntimeError("Reddit OAuth 换取 token 失败 (HTTP 401)——"
                           "请检查设置页的 client_id/client_secret")

    monkeypatch.setattr("backend.pipeline.collectors.reddit.ensure_reddit_token", _wrong)
    r = await client.get("/api/pipeline/reddit-auth/status?probe=true")
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is True and body["token_ok"] is False
    assert "client_id" in body["hint"]


# ---------- 一份事实一个作者 ----------


def test_configured_judgment_has_a_single_author() -> None:
    """`configured` 判据只写在 `deps.reddit_credentials_configured()` 里。

    端点自己再 `bool(id and secret)` 一遍就是第二个作者——两边对「填了空格算不算」
    的理解迟早漂移，届时矩阵说 ok、端点说没配，用户看到的还是自相矛盾的两行字。
    """
    router_src = (ROOT / "backend/routers/pipeline_ops.py").read_text(encoding="utf-8")
    assert "reddit_credentials_configured" in router_src, "端点没消费唯一作者，八成是重写了一遍"
    assert "pipeline_reddit_client_secret" not in router_src, "判据在端点里第二次出现"


def test_card_delegates_to_the_shared_judgment(monkeypatch) -> None:
    """矩阵条目也必须走同一个 helper，而不是自己再数一遍字段。"""
    monkeypatch.setattr(deps, "reddit_credentials_configured", lambda: True)
    monkeypatch.setattr(settings, "pipeline_reddit_client_id", "")
    monkeypatch.setattr(settings, "pipeline_reddit_client_secret", "")
    assert deps._check_reddit_auth()["status"] == "ok"

