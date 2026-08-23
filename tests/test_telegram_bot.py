"""Telegram 审核 Bot 契约测试（v0.18 补齐）：回调解析 / 推送去重 / 轮询分发。

httpx 全部 mock（monkeypatch _call）——不触碰真实网络。
"""

import uuid

import pytest

from backend.integrations import telegram_bot as tg
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory


async def _mk_queued(sid: str, title: str) -> str:
    async with session_factory() as session:
        row = Item(
            status=ItemStatus.QUEUED, source="reddit", source_id=f"tgb-{sid}",
            title=title, subreddit="aww", author="u", reddit_score=100,
            score_total=7.0, source_url=f"https://reddit.com/r/aww/comments/{sid}/",
        )
        session.add(row)
        await session.commit()
        return str(row.id)



@pytest.fixture(autouse=True)
async def _clean_tgb():
    """本文件条目/通知测试后清除——conftest 无 per-test 清表，
    残留 queued 条目会被后续轮次误推。"""
    yield
    from sqlalchemy import delete

    from backend.models.item import Item
    from backend.models.session import session_factory
    from backend.models.system import TelegramNotification

    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source_id.like("tgb-%")))
        await session.execute(delete(TelegramNotification))
        await session.commit()


@pytest.fixture(autouse=True)
def _tg_env(monkeypatch):
    """启用 bot 并固定 chat_id；清理通知表状态由各测试自行处理。"""
    monkeypatch.setattr(tg.settings, "telegram_enabled", True)
    monkeypatch.setattr(tg.settings, "telegram_bot_token", "test-token")
    monkeypatch.setattr(tg.settings, "telegram_chat_id", "12345")


@pytest.mark.asyncio
async def test_review_push_dedupes_after_restart(client) -> None:
    """同一 queued 条目只推一次——重启（新 tick 实例）后不重推。"""
    await _mk_queued("tg-1", "待审条目一")
    calls: list[tuple[str, dict]] = []

    async def fake_call(client_, method, payload):
        calls.append((method, payload))
        if method == "sendMessage":
            return {"message_id": len(calls) + 100}
        return []

    monkey = pytest.MonkeyPatch()
    monkey.setattr(tg, "_call", fake_call)
    try:
        svc = object()  # push_tick 不用 service
        await tg.review_push_tick(svc)
        await tg.review_push_tick(svc)  # 第二轮（模拟重启后再跑）
    finally:
        monkey.undo()

    mine = [
        p for m, p in calls
        if m == "sendMessage" and "待审条目一" in p.get("data", {}).get("caption", "")
    ]
    assert len(mine) == 1  # 去重生效


@pytest.mark.asyncio
async def test_review_push_caption_contains_metadata(client) -> None:
    item_id = await _mk_queued("tg-2", "带元数据的条目")
    captured: dict = {}

    async def fake_call(client_, method, payload):
        body = payload.get("data") or {}
        cap = str(body.get("caption", ""))
        if method in ("sendMessage", "sendPhoto") and "带元数据的条目" in cap:
            captured.update(payload)
            return {"message_id": 777}
        return None

    monkey = pytest.MonkeyPatch()
    monkey.setattr(tg, "_call", fake_call)
    try:
        await tg.review_push_tick(object())
    finally:
        monkey.undo()

    from backend.models.item import Item as _I
    from backend.pipeline.publish_queue import PHASE_NONE as _PN

    async def _dump():
        async with session_factory() as s:
            rows = (await s.execute(
                __import__("sqlalchemy").select(_I.title, _I.status)
                .where(_I.status == "queued", _I.queue_phase == _PN)
                .order_by(_I.seq.asc()).limit(12)
            )).all()
        print("QUEUED DUMP:", [(t[:24], st) for t, st in rows])

    import asyncio as _asyncio
    _asyncio.get_event_loop().run_until_complete(_dump()) if False else None
    body = captured["data"]
    assert "带元数据的条目" in body["caption"]
    assert "r/aww" in body["caption"]
    assert "AI 7.0" in body["caption"]
    kb = body["reply_markup"]["inline_keyboard"][0]
    actions = {b["callback_data"].split(":")[0] for b in kb}
    assert actions == {"approve", "reject", "back_to_prep"}
    assert all(d.endswith(item_id) for d in (b["callback_data"] for b in kb))


# ---------- poll_tick 回调分发 ----------


class _FakeService:
    def __init__(self):
        self.calls: list[tuple] = []

    async def act_by_id(self, item_id, action):
        self.calls.append((item_id, action))
        return {"ok": True}


@pytest.mark.asyncio
async def test_poll_dispatches_callback_to_service(client, monkeypatch) -> None:
    iid = uuid.uuid4()
    updates = [{
        "update_id": 10,
        "callback_query": {
            "id": "cbq-1",
            "from": {"id": 12345},
            "data": f"approve:{iid}",
            "message": {"message_id": 55,
                        "chat": {"id": 12345},
                        "text": "Some title\nr/aww"},
        },
    }]
    edits: list[dict] = []
    answered: list[str] = []

    async def fake_call(client_, method, payload):
        if method == "getUpdates":
            return updates
        if method == "answerCallbackQuery":
            answered.append(payload["json"]["text"])
        if method == "editMessageText":
            edits.append(payload["json"])
        return None

    mp = pytest.MonkeyPatch()
    mp.setattr(tg, "_call", fake_call)
    try:
        svc = _FakeService()
        await tg.poll_tick(svc)
    finally:
        mp.undo()

    assert svc.calls == [(iid, "approve")]
    assert any("已通过" in a for a in answered)
    assert edits and "已通过" in edits[0]["text"]
    # offset 前进：下一轮不再拿到同一条 update
    assert tg.poll_tick._offset == 11


def test_parse_callback_whitelist() -> None:
    iid = str(uuid.uuid4())
    assert tg.parse_callback(f"approve:{iid}") == ("approve", iid)
    assert tg.parse_callback(f"reject:{iid}") == ("reject", iid)
    assert tg.parse_callback("unknown:x") is None
    assert tg.parse_callback("no-colon") is None
    assert tg.parse_callback(None) is None


@pytest.mark.asyncio
async def test_poll_ignores_foreign_chat(client, monkeypatch) -> None:
    """非配置 chat 的回调静默忽略——最小信任面。"""
    iid = uuid.uuid4()
    updates = [{
        "update_id": 20,
        "callback_query": {
            "id": "cbq-2", "from": {"id": 999},
            "data": f"approve:{iid}",
            "message": {"message_id": 1, "chat": {"id": 999}},
        },
    }]

    async def fake_call(client_, method, payload):
        return updates if method == "getUpdates" else None

    mp = pytest.MonkeyPatch()
    mp.setattr(tg, "_call", fake_call)
    try:
        svc = _FakeService()
        await tg.poll_tick(svc)
        assert svc.calls == []
    finally:
        mp.undo()
