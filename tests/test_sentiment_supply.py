"""C 切片：情感文字供给链的可判部分（离线）。

三件事各自都可机械验证，不需要网络：

1. **匿名 JSON 通道也要 `raw_json=1`**。OAuth 通道一直传（`reddit.py:268`），
   匿名通道不传——`raw_json=0` 时 Reddit 按自家渲染返回 `selftext`，
   `&#32;` / `&amp;` 这类实体直接进库。一个以文字为弹药的垂类第一天就吃到脏正文。
2. **`quality.reassess()` 能清标**。`stamp` 的既有语义是「只加隔离标、不清标」，
   所以回填正文之后必须有一个「理由不再成立就把标摘掉」的**唯一**出口——
   回填脚本自己写 `is_invalid=False` 就是第二个作者。
3. **体检第 7 条 `story_without_text`**：`item_type='text_only'` 却低于正文门槛，
   正是供给链断裂的现场形状，常驻可见才不会再靠人工发现。

实测背景（`docs/ROADMAP.md` 在飞段）：`items.selftext` 在 dev 库 **0/5281**，
隔离的 2196 条里 2013 条落在情感名单、1982 条来自文字为主子版。
"""

from __future__ import annotations

import ast
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline import integrity, quality

REDDIT_PY = Path("backend/pipeline/collectors/reddit.py")

#: 回填脚本里代理判据的替身值（真值来自 net.system_proxy，测试里不许依赖本机网络配置）
PROXY = "http://127.0.0.1:7897"


# ---------- 1. raw_json 两个通道同源 ----------


class _CapturingClient:
    """只记录 params 的假 client：不发网络，也不断言响应形状。"""

    def __init__(self, payload: dict) -> None:
        self.calls: list[tuple[str, dict]] = []
        self._payload = payload

    async def get(self, url: str, params: dict | None = None, **kw):
        self.calls.append((url, dict(params or {})))

        class _Resp:
            status_code = 200

            @staticmethod
            def raise_for_status() -> None:
                return None

            @staticmethod
            def json() -> dict:
                return payload

        payload = self._payload
        return _Resp()


def _empty_listing() -> dict:
    return {"data": {"children": []}}


@pytest.mark.asyncio
async def test_anonymous_json_sends_raw_json() -> None:
    """匿名 JSON 通道必须带 raw_json=1——否则 selftext 是转义实体。"""
    from backend.pipeline.collectors.reddit import RedditCollector

    client = _CapturingClient(_empty_listing())
    collector = RedditCollector(client=client)  # 若构造签名不同，按文件实际形状传
    await collector._collect_json("offmychest", "new", 10)
    url, params = client.calls[0]
    assert url.endswith(".json"), url
    assert params.get("raw_json") == 1, f"匿名通道又回到转义正文了：{params}"


@pytest.mark.asyncio
async def test_oauth_channel_still_sends_raw_json() -> None:
    from backend.pipeline.collectors.reddit import RedditCollector

    client = _CapturingClient(_empty_listing())
    collector = RedditCollector(client=client)
    await collector._collect_oauth("offmychest", "new", 10, token="t-abc")
    _url, params = client.calls[0]
    assert params.get("raw_json") == 1


def test_raw_json_has_one_author() -> None:
    """`raw_json` 这个字面量在 reddit.py 里只许出现一次（共用构造函数）。"""
    src = REDDIT_PY.read_text(encoding="utf-8")
    assert src.count('"raw_json"') == 1, (
        f"raw_json 出现了 {src.count(chr(34) + 'raw_json' + chr(34))} 次——"
        "两个通道各写一份就会漂移（一个补了一个没补）"
    )


# ---------- 2. reassess 能清标 ----------


def _shell(**kw) -> Item:
    base = dict(
        status=ItemStatus.DISCOVERED,
        source="reddit",
        source_id="reassess-probe",
        title="我 (28F) 和丈夫在一起六年",
        subreddit="offmychest",
        item_type="",
        media_url=None,
        selftext=None,
    )
    return Item(**{**base, **kw})


def test_stamp_then_reassess_clears_when_story_arrives() -> None:
    """先按空壳隔离，补进正文之后 reassess 必须把标摘掉并定成 text_only。"""
    item = _shell()
    quality.stamp(item)
    assert item.is_invalid is True, "无媒体无正文应当被隔离（既有行为）"

    item.selftext = "我 (28F) 和丈夫在一起六年。" * 12  # 远超 MIN_STORY_CHARS
    cleared = quality.reassess(item)
    assert cleared is True
    assert item.is_invalid is False
    assert item.item_type == "text_only"
    assert item.error_class != quality.INVALID_REASON


def test_reassess_keeps_shell_when_still_empty() -> None:
    """仍然没有正文 → 保持隔离，且不许把原因文案改掉。"""
    item = _shell()
    quality.stamp(item)
    before = (item.error_class, item.error)
    assert quality.reassess(item) is False
    assert item.is_invalid is True
    assert (item.error_class, item.error) == before


def test_reassess_never_touches_terminal_status() -> None:
    """终态一律不动。判据范围沿用 quality 自己的 `QUARANTINABLE_STATUSES`——
    这里从它取补集，而不是在测试里另列一份「哪些算终态」（那就是第二个作者）。"""
    terminals = [s for s in ItemStatus if s not in quality.QUARANTINABLE_STATUSES]
    assert terminals, "补集为空说明 QUARANTINABLE_STATUSES 覆盖了一切，本测无意义"
    for terminal in terminals:
        item = _shell(status=terminal, is_invalid=True, error_class=quality.INVALID_REASON)
        assert quality.reassess(item) is False, terminal
        assert item.is_invalid is True, f"reassess 动了终态 {terminal}"


def test_reassess_does_not_clobber_foreign_error_class() -> None:
    """别人（人工/其他失败路径）写的 error_class 优先，清标只清自己那条。"""
    item = _shell()
    quality.stamp(item)
    item.error_class = "download_failed"
    item.error = "HTTP_403"
    item.selftext = "长正文 " * 60
    assert quality.reassess(item) is False
    assert (item.error_class, item.error) == ("download_failed", "HTTP_403")


# ---------- 3. 体检第 3 条：长期红的报警器等于没有报警器 ----------


@pytest.mark.asyncio
async def test_quarantined_queued_shell_is_out_of_artifact_scope() -> None:
    """隔离条目不在「产物不变量」的取行范围内，摘掉隔离标就回来。

    为什么不再用「插数据 + 比全局计数」：dev 库里本来就有其它真 offender，且它们
    随其它测试文件建的数据浮动——全量首跑就把这条测成了 9 → 9（顺序敏感）。
    改成直接断言**取行范围**（`integrity.artifact_scope()`）落在我这两行上的结果，
    与无关数据无关，仍然能区分好坏：把 is_invalid 条件删掉，parked 就会被纳进来。
    """
    from sqlalchemy import and_, func

    ids = ["integrity-parked-shell", "integrity-broken-file"]
    parked = Item(
        status=ItemStatus.QUEUED,
        source="reddit",
        source_id=ids[0],
        title="已隔离的空壳",
        subreddit="funny",
        is_invalid=True,
        error_class=quality.INVALID_REASON,
        error="空壳",
        raw_path="media/gone-a.mp4",
    )
    broken = Item(
        status=ItemStatus.QUEUED,
        source="reddit",
        source_id=ids[1],
        title="产物文件真没了",
        subreddit="funny",
        raw_path="media/gone-b.mp4",
    )

    async def _in_scope() -> int:
        async with session_factory() as session:
            return (
                await session.execute(
                    select(func.count())
                    .select_from(Item)
                    .where(and_(*integrity.artifact_scope()), Item.source_id.in_(ids))
                )
            ).scalar()

    async with session_factory() as session:
        session.add_all([parked, broken])
        await session.commit()
    try:
        assert await _in_scope() == 1, "只有未隔离的那条该在范围内（否则报警器长期红）"

        async with session_factory() as session:
            row = (await session.execute(select(Item).where(Item.source_id == ids[0]))).scalar_one()
            row.is_invalid = False
            await session.commit()
        assert await _in_scope() == 2, "摘掉隔离标后必须回到范围内"
    finally:
        from sqlalchemy import delete

        async with session_factory() as session:
            await session.execute(delete(Item).where(Item.source_id.in_(ids)))
            await session.commit()


def test_downloaded_check_uses_the_shared_scan_cap() -> None:
    """窗口必须接回本文件唯一的 `SCAN_CAP`。

    写成**正向**断言而不是「不许出现 limit(500)」：本文件与 integrity 的说明文字里
    都出现了 `limit(500)` 这个词（解释缺陷时无法不提它），负向文本扫描会把叙述自己
    的话当成缺陷——这是「文本扫描守卫要配行为腿/别拿散文当扳机」的同一课。
    正向断言同样能红：谁改回私有小窗口，`.limit(SCAN_CAP)` 就消失。
    """
    src = Path("backend/pipeline/integrity.py").read_text(encoding="utf-8")
    body = src[
        src.index("async def check_downloaded_without_file") : src.index(
            "async def check_duplicate_source_id"
        )
    ]
    assert ".limit(SCAN_CAP)" in body, "窗口没接回 SCAN_CAP（私有小窗口会让计数不动）"


def test_downloaded_check_reuses_the_operable_scope_author() -> None:
    """「什么算可操作」的判据作者是 operational_filters，第二条写处即为缺陷。"""
    src = Path("backend/pipeline/integrity.py").read_text(encoding="utf-8")
    body = src[
        src.index("async def check_downloaded_without_file") : src.index(
            "async def check_duplicate_source_id"
        )
    ]
    assert "operational_filters" in body, "又手写了一遍 archived/is_invalid 条件"


# ---------- 4. 体检第 7 条 ----------


@pytest.mark.asyncio
async def test_story_without_text_is_reported_and_quiets() -> None:
    """正负样本都要：插一条脏行必红，撤掉之后必静——单向断言等于没测。"""
    sid = "integrity-story-without-text"
    async with session_factory() as session:
        session.add(
            Item(
                status=ItemStatus.DISCOVERED,
                source="reddit",
                source_id=sid,
                title="脏行",
                subreddit="offmychest",
                item_type="text_only",
                selftext="",
                created_at=datetime.now(UTC),
            )
        )
        await session.commit()
    try:
        report = await integrity.integrity_report()
        hit = [f for f in report["findings"] if f["name"] == "story_without_text"]
        assert hit and hit[0]["count"] >= 1, "插了 text_only 空正文却不报——这条不变量是空转的"
    finally:
        from sqlalchemy import delete

        async with session_factory() as session:
            await session.execute(delete(Item).where(Item.source_id == sid))
            await session.commit()
    report = await integrity.integrity_report()
    hit = [f for f in report["findings"] if f["name"] == "story_without_text"]
    assert not hit or hit[0]["count"] == 0, "脏行已撤仍报=把历史算进来了"


def test_integrity_registers_seventh_check() -> None:
    """CHECKS 里必须真有第七个函数，且命名遵循文件既有约定（check_ 前缀）。"""
    names = [c.__name__ for c in integrity.CHECKS]
    assert "check_story_without_text" in names, names
    src = Path("backend/pipeline/integrity.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    assert any(
        isinstance(n, ast.AsyncFunctionDef) and n.name == "check_story_without_text"
        for n in tree.body
    ), "CHECKS 里的名字必须真有实现，不是只挂了个名"


# ---------- 5. 回填脚本：连不上就不开始，代理不许按通道分家 ----------


def _load_backfill():
    """按路径加载 scripts/ 下的脚本（scripts 不是包，只能 importlib）。"""
    import importlib.util

    path = Path("scripts/backfill-selftext.py").resolve()
    spec = importlib.util.spec_from_file_location("backfill_selftext", path)
    assert spec is not None and spec.loader is not None, path
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _FakeClient:
    """假 AsyncClient：按预设演「抛连接错误」或「返回某状态码」，并记下构造参数。"""

    def __init__(self, *, status_code=None, error=None, kwargs_log=None, **kwargs) -> None:
        self._status = status_code
        self._error = error
        if kwargs_log is not None:
            kwargs_log.append(kwargs)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> bool:
        return False

    async def get(self, url: str, params=None, **kw):
        if self._error is not None:
            raise self._error
        return SimpleNamespace(
            status_code=self._status,
            json=lambda: {"data": {"children": []}},
        )


def _patch_probe_client(monkeypatch, module, *, status_code=None, error=None, log=None):
    """让脚本里的 `httpx.AsyncClient(...)` 换成 `_FakeClient`，并固定代理值。"""
    monkeypatch.setattr("backend.infrastructure.net.system_proxy", lambda: PROXY)
    monkeypatch.setattr(
        module.httpx,
        "AsyncClient",
        lambda *a, **k: _FakeClient(
            status_code=status_code, error=error, kwargs_log=log, **k
        ),
    )


@pytest.mark.asyncio
async def test_probe_down_on_connect_error(monkeypatch) -> None:
    """连不上必须判「下行」——这是 docstring 承诺的那一步，不是只写在注释里。"""
    module = _load_backfill()
    _patch_probe_client(monkeypatch, module, error=httpx.ConnectError("egress down"))
    ok, detail = await module._probe(None)
    assert ok is False, f"连不上却判成能出网：{ok} {detail}"
    assert "ConnectError" in detail, detail


@pytest.mark.asyncio
async def test_probe_separates_answered_from_unreachable(monkeypatch) -> None:
    """403 是「源站答了」（能开始，拿没拿到由计数说话）；5xx 是出网坏了（不能开始）。

    两条一起测才排除「`return True` 蒙过第一半」——只测 200 通、只测 599 不通，
    都不足以证明这条判据分得开「被拒绝」和「连不上」。
    """
    module = _load_backfill()

    _patch_probe_client(monkeypatch, module, status_code=403)
    ok_403, detail_403 = await module._probe(None)
    assert ok_403 is True, f"403 被当成连不上，回填会永远不敢开始：{detail_403}"

    _patch_probe_client(monkeypatch, module, status_code=599)
    ok_599, detail_599 = await module._probe(None)
    assert ok_599 is False, f"源站 5xx 却判成可出网：{detail_599}"


@pytest.mark.asyncio
async def test_run_refuses_to_start_when_probe_fails(monkeypatch) -> None:
    """探针失败 ⇒ 退出码非 0 且**一个查询都不发**。

    为什么盯「不发查询」：探针失败后继续跑，输出会是「回填候选 0 条」，
    而「已回填完」和「根本连不上」在界面上长得一模一样——运维按前者决定下一步
    就会把断供当成库存充足。
    """
    import backend.pipeline.collectors.reddit as reddit_mod

    module = _load_backfill()

    async def _no_token():
        return None

    monkeypatch.setattr(reddit_mod, "ensure_reddit_token", _no_token)
    _patch_probe_client(monkeypatch, module, error=httpx.ConnectError("egress down"))

    def _no_db(*a, **k):
        raise AssertionError("探针失败时不该碰数据库")

    monkeypatch.setattr(module, "session_factory", _no_db)
    assert await module.run(apply=True, limit=10) == 2


@pytest.mark.asyncio
async def test_fetch_proxies_both_channels(monkeypatch) -> None:
    """OAuth 通道也要挂系统代理——代理判据只有一个作者，不按 URL 前缀分家。

    旧写法是 `proxy=... if url.startswith("https://www.") else None`，于是
    「配了凭证反而不走代理」：本机出网全靠那个代理，凭证越齐越连不上。
    """
    module = _load_backfill()
    seen: list[dict] = []
    _patch_probe_client(monkeypatch, module, status_code=200, log=seen)
    out: dict[str, str] = {}
    await module._fetch(out, ["abc123"], token="t-abc")
    assert seen, "假 client 没被调用，探针等于没测"
    assert seen[0].get("proxy") == PROXY, f"oauth 通道没挂代理：{seen[0]}"
