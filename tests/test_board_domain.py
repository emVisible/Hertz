"""看板域（v0.34 B）：每日目标与今日关注的后端行为。

命名沿革：本功能早期叫 `daily_plan` / `plan_store`，因 `backend/models/plan.py` 已被
编排域占用（`plans` / `Plan`），一律改名 `daily_goal` / `board_store`（见 spec §4.1）。

四条判据各自都有正反两半——单向断言的测试等于没测（v0.33 的教训，写进本仓库记忆）。
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from uuid import UUID, uuid4

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import delete, select

from backend.models.board import DailyGoal
from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory
from backend.pipeline import board, board_store

ROOT = Path(__file__).resolve().parents[1]


# ---------- 迁移：可升可降，且不许动多 head 现状 ----------


def test_wave31_joins_main_line_and_heads_stay_two() -> None:
    """heads 必须**仍是 2**：变成 1 = 有人合并了悬空分支，变成 3 = 这条迁移自己开了头。"""
    script = ScriptDirectory.from_config(Config(str(ROOT / "alembic.ini")))
    assert len(script.get_heads()) == 2
    rev = script.get_revision("wave31_board_goal")
    assert rev.down_revision == "wave30_item_invalid"


def test_daily_goal_model_shape() -> None:
    tbl = DailyGoal.__table__
    assert tbl.name == "daily_goal"
    assert tbl.c.goal_date.nullable is False
    # 唯一性必须真的成立（一天一行的身份）。写 `or True` 会让这条永真——那就不叫断言。
    has_unique = tbl.c.goal_date.unique or any(
        [c.name for c in con.columns] == ["goal_date"]
        for con in tbl.constraints
        if con.__class__.__name__ == "UniqueConstraint"
    )
    assert has_unique, "goal_date 必须有唯一约束"
    cols = {c.name: c for c in Item.__table__.columns}
    assert cols["focus_date"].nullable is True and cols["focus_note"].nullable is True
    # 有意不建索引（选择性不足）：这里钉住「没建」而不是「建了」
    assert not any("focus_date" in [c.name for c in i.columns] for i in Item.__table__.indexes), (
        "focus_date 不该有索引（v0.32 S2 的实测口径）"
    )


# ---------- 每日目标 ----------


@pytest.mark.asyncio
async def test_get_goal_is_side_effect_free() -> None:
    day = date(2034, 6, 1)
    got = await board_store.get_goal(day)
    assert got == {"goal_date": "2034-06-01", "goal_text": "", "updated_at": None}
    async with session_factory() as session:
        n = (
            await session.execute(select(DailyGoal).where(DailyGoal.goal_date == day))
        ).scalar_one_or_none()
    assert n is None, "读操作不许建行"


@pytest.mark.asyncio
async def test_put_goal_upserts_one_row_per_day() -> None:
    day = date(2034, 6, 2)
    try:
        a = await board_store.put_goal(day, "今天过一遍 AITA 前 20 条")
        b = await board_store.put_goal(day, "改成 30 条")
        assert a["goal_date"] == b["goal_date"] == "2034-06-02"
        assert b["goal_text"] == "改成 30 条"
        async with session_factory() as session:
            rows = (
                (await session.execute(select(DailyGoal).where(DailyGoal.goal_date == day)))
                .scalars()
                .all()
            )
            assert len(rows) == 1, f"一天必须只有一行，实际 {len(rows)}"
            assert rows[0].goal_text == "改成 30 条"
    finally:
        async with session_factory() as session:
            await session.execute(delete(DailyGoal).where(DailyGoal.goal_date == day))
            await session.commit()


@pytest.mark.asyncio
async def test_overlong_goal_rejected_by_the_single_author() -> None:
    with pytest.raises(ValueError, match=str(board_store.GOAL_MAX_CHARS)):
        await board_store.put_goal(date(2034, 6, 3), "x" * (board_store.GOAL_MAX_CHARS + 1))


# ---------- 今日关注（唯一写入口） ----------


async def _mk_item(**kw) -> str:
    base = {
        "status": ItemStatus.DISCOVERED,
        "source": "reddit",
        "item_type": "video_raw",
        "media_url": "https://v.redd.it/probe/DASHPlaylist.mpd",
        "title": "样本条目",
        "subreddit": "offmychest",
    }
    row = Item(**{**base, **kw, "source_id": kw.pop("source_id", f"board-{uuid4()}")})
    async with session_factory() as session:
        session.add(row)
        await session.commit()
        return str(row.id)


@pytest.mark.asyncio
async def test_focus_patch_semantics() -> None:
    """局部 PATCH：只发日期不许把备注清空；归档条目一律拒绝。"""
    iid = await _mk_item()
    try:
        first = await board_store.set_focus(
            iid, focus_date=date(2034, 6, 4), focus_note="开头太散，重写钩子", touch_note=True
        )
        assert first["focus_date"] == "2034-06-04" and first["focus_note"].startswith("开头")

        second = await board_store.set_focus(
            iid, focus_date=None, focus_note=None, touch_note=False
        )
        assert second["focus_date"] is None
        assert second["focus_note"] == "开头太散，重写钩子", "touch_note=False 时不许清备注"

        async with session_factory() as session:
            row = await session.get(Item, UUID(iid))
            row.archived = True
            await session.commit()
        with pytest.raises(ValueError, match="归档"):
            await board_store.set_focus(
                iid, focus_date=date(2034, 6, 5), focus_note=None, touch_note=False
            )
    finally:
        async with session_factory() as session:
            await session.execute(delete(Item).where(Item.id == UUID(iid)))
            await session.commit()


@pytest.mark.asyncio
async def test_focus_on_missing_item_raises_lookup() -> None:
    with pytest.raises(LookupError):
        await board_store.set_focus(
            str(uuid4()), focus_date=date(2034, 6, 6), focus_note=None, touch_note=True
        )


# ---------- 分列：纯函数，一条记录只能进一列 ----------


def _row(iid: str, status: str, *, focus: str | None = None, published: str | None = None) -> dict:
    return {
        "id": iid,
        "status": status,
        "focus_date": focus,
        "published_at": published,
        "title": iid,
    }


#: 看板分列用的「今天」与一个跨午夜的 UTC 区间（前端就是这样下发的）
DAY = "2034-07-01"

#: 一个「既在制又已被今日捞走」的重叠样本——分列优先级只能在这里定，
#: 端点是每列各查一次的，不去重就会重复计数。
OVERLAP = {
    "items": [
        _row("a", "approved", focus=DAY),
        _row("b", "scored"),
        _row("c", "queued"),
        _row("d", "published", published="2034-07-01T02:00:00+00:00", focus=DAY),
        _row("e", "published", published="2034-06-30T10:00:00+00:00"),
        _row("f", "discovered"),
    ],
    "from": "2034-06-30T16:00:00+00:00",
    "to": "2034-07-01T16:00:00+00:00",
}


def test_one_row_lands_in_exactly_one_column() -> None:
    out = board.build_columns(OVERLAP["items"], DAY, OVERLAP["from"], OVERLAP["to"])
    seen: list[str] = []
    for column in out["columns"].values():
        seen.extend(str(r["id"]) for r in column)
    assert len(seen) == len(set(seen)), f"一条记录出现在两列：{seen}"
    # 「捞进今日」优先于状态列：a 被今天捞走，就不该同时出现在「待发布」里
    assert [r["id"] for r in out["columns"]["focus"]] == ["a"]
    assert [r["id"] for r in out["columns"]["in_work"]] == ["b"]
    assert [r["id"] for r in out["columns"]["review"]] == ["c"]
    assert out["columns"]["ready_to_publish"] == [], "a 已归 focus，待发列不该再算它"
    # d 落在窗口内、e 落在窗口外（`from` 之前）；published 且今天捞入的 d 仍归发布列
    assert [r["id"] for r in out["columns"]["published_today"]] == ["d"]
    # f 是未评分区的事，看板不接
    assert "f" not in seen


def test_progress_uses_real_published_count_not_checkboxes() -> None:
    """spec §4.3 的完成度语义：M = 今天捞入的条数（含已发的），N = 其中今天发掉的。"""
    out = board.build_columns(OVERLAP["items"], DAY, OVERLAP["from"], OVERLAP["to"])
    assert out["progress"] == {"focused": 2, "published_of_focus": 1}, out["progress"]


def test_window_is_half_open_at_both_ends() -> None:
    """边界：`from` 含、`to` 不含。含两端就会把跨午夜的发布数到两天里去。"""
    items = [
        _row("at-from", "published", published=OVERLAP["from"]),
        _row("at-to", "published", published=OVERLAP["to"]),
    ]
    out = board.build_columns(items, DAY, OVERLAP["from"], OVERLAP["to"])
    assert [r["id"] for r in out["columns"]["published_today"]] == ["at-from"]


def test_counts_report_pre_truncation_size() -> None:
    """counts 必须是**截断前**的条数：界面写「共 N 条」时不能拿展示条数冒充。"""
    many = [_row(f"x{i}", "queued") for i in range(board.COLUMN_LIMITS["review"] + 7)]
    out = board.build_columns(many, DAY, OVERLAP["from"], OVERLAP["to"])
    assert out["counts"]["review"] == len(many)
    assert len(out["columns"]["review"]) == board.COLUMN_LIMITS["review"]


# ---------- ISO 归一化：单一作者 ----------


def test_utc_instant_normalizes_z_and_naive_and_rejects_garbage() -> None:
    from backend.pipeline.service_queries import utc_instant

    assert utc_instant("2034-07-01T00:00:00Z").isoformat() == "2034-07-01T00:00:00+00:00"
    # 裸时间按 UTC 解释（后端不做时区推断，spec §4.1）
    assert utc_instant("2034-07-01T00:00:00").utcoffset().total_seconds() == 0
    # +08:00 必须真的换算成 UTC，而不是截掉偏移后当 UTC 用
    assert utc_instant("2034-07-01T08:00:00+08:00").isoformat() == "2034-07-01T00:00:00+00:00"
    with pytest.raises(ValueError):
        utc_instant("明天上午")


# ---------- 端点：真发一次请求，读回列与目标 ----------


@pytest.mark.asyncio
async def test_board_endpoint_columns_goal_and_focus(client) -> None:
    day = date(2034, 7, 1)
    ids = {
        "focus_approved": await _mk_item(status=ItemStatus.APPROVED),
        "in_work": await _mk_item(status=ItemStatus.SCORED),
        "published": await _mk_item(status=ItemStatus.PUBLISHED),
    }
    try:
        async with session_factory() as session:
            await board_store.put_goal(day, "过一遍 AITA 前 20 条")
            for key, focus, published in (
                ("focus_approved", day, None),
                ("in_work", None, None),
                ("published", day, datetime(2034, 7, 1, 2, 0, tzinfo=UTC)),
            ):
                row = await session.get(Item, UUID(ids[key]))
                row.focus_date = focus
                row.published_at = published
                if published is not None:
                    row.status = ItemStatus.PUBLISHED
            await session.commit()

        resp = await client.get(
            "/api/pipeline/board",
            params={
                "date": "2034-07-01",
                "from": "2034-06-30T16:00:00Z",
                "to": "2034-07-01T16:00:00Z",
            },
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["goal_text"] == "过一遍 AITA 前 20 条"

        # 断言只按「我自己那几行落在哪一列」，不按全局计数——测试库是共享的，
        # 全局 +N 断言必然随执行顺序漂（v0.33 实测踩过一次）。
        def _ids(column: str) -> set[str]:
            return {str(r["id"]) for r in body["columns"][column]}

        assert ids["focus_approved"] in _ids("focus"), body["counts"]
        assert ids["in_work"] in _ids("in_work"), body["counts"]
        assert ids["published"] in _ids("published_today"), body["counts"]
        # 今天捞入但已发布的：归发布列，不再重复出现在 focus 列（一列一条记录）
        assert ids["published"] not in _ids("focus")
        assert body["progress"]["focused"] >= 2, body["progress"]
        assert body["progress"]["published_of_focus"] >= 1, body["progress"]
        # 区间必须由后端归一化后再回显：前端发 Z、回读 +00:00，两端同一格式
        assert body["published_from"] == "2034-06-30T16:00:00+00:00", body["published_from"]
    finally:
        async with session_factory() as session:
            await session.execute(delete(Item).where(Item.id.in_([UUID(i) for i in ids.values()])))
            await session.execute(delete(DailyGoal).where(DailyGoal.goal_date == day))
            await session.commit()


def test_board_and_router_do_not_write_their_own_sql() -> None:
    """看板与看板端点都不许出现 `select(` —— 条目取数只有 `list_items` 一个作者。"""
    for rel in ("backend/pipeline/board.py", "backend/routers/pipeline_board.py"):
        src = (ROOT / rel).read_text(encoding="utf-8")
        assert "select(" not in src, f"{rel} 里出现了 SQL：条目查询条件的作者变成两个"
    router_src = (ROOT / "backend/routers/pipeline_board.py").read_text(encoding="utf-8")
    assert "list_items" in router_src, "看板端点必须走 list_items 取数，不是自己拼条件"


@pytest.mark.asyncio
async def test_board_endpoint_asks_for_the_documented_columns(client, monkeypatch) -> None:
    """端点每列各查一次，且筛选参数就是 spec §4.2 那张表（防第二作者的正面腿）。

    用替身拦在 `list_items` 上：只记录 kwargs、不返回数据，所以这里断言的是
    「问了什么」，与上一条「答回来怎么分列」互不重复。
    """
    import backend.routers.pipeline_board as pb

    calls: list[dict] = []

    class _Spy:
        async def list_items(self, **kwargs):
            calls.append(kwargs)
            return []

    monkeypatch.setattr(pb, "_pipe", lambda: _Spy())
    resp = await client.get(
        "/api/pipeline/board",
        params={
            "date": "2034-07-03",
            "from": "2034-07-02T16:00:00Z",
            "to": "2034-07-03T16:00:00Z",
        },
    )
    assert resp.status_code == 200, resp.text
    assert {"focus_date": "2034-07-03", "limit": board.COLUMN_LIMITS["focus"]} in calls, calls
    assert {"status": "downloaded,scored", "limit": board.COLUMN_LIMITS["in_work"]} in calls, calls
    assert {"status": "queued", "limit": board.COLUMN_LIMITS["review"]} in calls, calls
    assert {
        "status": "approved",
        "limit": board.COLUMN_LIMITS["ready_to_publish"],
    } in calls, calls
    published = [c for c in calls if c.get("status") == "published"]
    assert published and published[0]["published_from"] == "2034-07-02T16:00:00+00:00", calls
    assert len(calls) == 5, f"每列各一次，多了就是有人自己加了一遍查询：{len(calls)}"


@pytest.mark.asyncio
async def test_list_items_focus_filter_is_not_decorative(client) -> None:
    """`focus_date` 必须真的进 WHERE——收下参数却不用是这一类缺陷最静的形状。

    第二条条目**更晚入库**且没有 focus_date：如果筛选是摆设，它就会因为
    `seq desc` 排在最前面而混进今日列，看板上「今天捞了几条」随之虚高。
    """
    from backend.factory.registry import ServiceRegistry

    day = date(2034, 7, 4)
    focused = await _mk_item(status=ItemStatus.DISCOVERED)
    newer_unfocused = await _mk_item(status=ItemStatus.DISCOVERED)
    try:
        async with session_factory() as session:
            row = await session.get(Item, UUID(focused))
            row.focus_date = day
            await session.commit()
        got = await ServiceRegistry.get().pipeline.list_items(focus_date="2034-07-04", limit=50)
        ids = {str(r["id"]) for r in got}
        assert focused in ids, f"今日捞入的条目没被查出来：{ids}"
        assert newer_unfocused not in ids, "focus_date 筛选是摆设：没捞入的也回来了"
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(Item).where(Item.id.in_([UUID(focused), UUID(newer_unfocused)]))
            )
            await session.commit()
