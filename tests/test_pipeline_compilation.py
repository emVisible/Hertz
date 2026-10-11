"""多素材合集编排 API（v0.35）——`/api/pipeline/compilations`。

建合集的**结构性校验**是本文件的核心价值：这些规则（片段须已下载、不得自引用、
不得重复引用、不得嵌套）如果只在前端做，用户绕过界面直接打 API 就能造出
拼不出来的条目——而拼不出来是在**制作阶段**才暴露的，那时已经浪费了一次产出。

合成行专属 source 标记，跑完删干净（不给测试库留垃圾）。
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import delete

from backend.models.item import Item
from backend.models.session import session_factory
from backend.pipeline.producers.assemble import MAX_TRANSITION_S, MIN_TRANSITION_S
from backend.pipeline.service_compilation import MAX_CLIPS, normalize_clip_plan

SOURCE = "v035-compile"


async def _seed(status: str = "downloaded", *, raw: bool = True, n: int = 3,
                clips: dict | None = None) -> list[str]:
    """种 n 条源条目，返回 id 列表。"""
    ids: list[str] = []
    async with session_factory() as session:
        for i in range(n):
            row = Item(
                source=SOURCE, source_id=f"s{i}", status=status, item_type="video_raw",
                title=f"素材 {i}",
                raw_path=f"/tmp/v035-{i}.mp4" if raw else None,
                clips=clips,
            )
            session.add(row)
            await session.flush()
            ids.append(str(row.id))
        await session.commit()
    return ids


@pytest.fixture
async def clean_pool():
    await _clean()
    yield
    await _clean()


async def _clean() -> None:
    """清掉本文件造出的**全部**条目。

    两种 source 都要清：`SOURCE` 是源素材，而 `create_compilation` 建的合集
    条目 source 是 `"compilation"`（生产代码定的，不是我能改的）。只清前者时，
    合集条目会活到下一个文件——`test_pipeline_engine.py::test_chain_to_review_gate`
    断言 chain 只处理 1 条，被这些残留条目凑成 6 条就红了。

    这类污染的特征是「单跑通过、连跑失败」，定位它花的功夫比写这个测试多。
    """
    from sqlalchemy import or_

    async with session_factory() as session:
        await session.execute(
            delete(Item).where(or_(Item.source == SOURCE, Item.source == "compilation"))
        )
        await session.commit()


# ---------- 纯逻辑：normalize_clip_plan ----------


def test_clip_plan_requires_at_least_one_clip():
    with pytest.raises(ValueError, match="至少需要"):
        normalize_clip_plan([])
    with pytest.raises(ValueError, match="至少需要"):
        normalize_clip_plan(None)


def test_clip_plan_rejects_duplicate_reference():
    """同一条素材被引用两次 → 拒绝。

    不是「顺手去重」而是报错：成片里出现重复画面通常是编排没排对，
    静默去重会让用户以为配了两段、结果只看到一段内容，更难查。
    """
    one = str(uuid.uuid4())
    with pytest.raises(ValueError, match="重复"):
        normalize_clip_plan([{"item_id": one}, {"item_id": one}])


def test_clip_plan_rejects_invalid_transition():
    cid = str(uuid.uuid4())
    with pytest.raises(ValueError, match="不支持"):
        normalize_clip_plan([{"item_id": cid}, {"item_id": str(uuid.uuid4()),
                                                "transition": "火焰"}])


def test_clip_plan_first_clip_transition_forced_to_cut():
    """第一段的入场转场强制落成 cut——它没有「入场」可言。"""
    one, two = str(uuid.uuid4()), str(uuid.uuid4())
    plan = normalize_clip_plan([
        {"item_id": one, "transition": "fade"},
        {"item_id": two, "transition": "zoomin"},
    ])
    assert plan["clips"][0]["transition"] == "cut"
    assert plan["clips"][1]["transition"] == "zoomin"


def test_clip_plan_transition_duration_bounds():
    cid, cid2 = str(uuid.uuid4()), str(uuid.uuid4())
    with pytest.raises(ValueError, match="转场时长"):
        normalize_clip_plan([{"item_id": cid},
                             {"item_id": cid2, "transition_s": 0.01}])
    with pytest.raises(ValueError, match="转场时长"):
        normalize_clip_plan([{"item_id": cid},
                             {"item_id": cid2, "transition_s": 999}])
    ok = normalize_clip_plan([{"item_id": cid},
                              {"item_id": cid2, "transition_s": 1.5}])
    assert ok["clips"][1]["transition_s"] == pytest.approx(1.5)
    assert MIN_TRANSITION_S < 1.5 < MAX_TRANSITION_S


def test_clip_plan_cap():
    ids = [str(uuid.uuid4()) for _ in range(MAX_CLIPS + 1)]
    with pytest.raises(ValueError, match="最多"):
        normalize_clip_plan([{"item_id": i} for i in ids])


def test_clip_plan_outro_bounds():
    cid = str(uuid.uuid4())
    with pytest.raises(ValueError, match="片尾时长"):
        normalize_clip_plan([{"item_id": cid}], {"enabled": True, "duration_s": 99})
    plan = normalize_clip_plan([{"item_id": cid}], {"enabled": True, "duration_s": 3})
    assert plan["outro"]["enabled"] is True


# ---------- HTTP 层 ----------


@pytest.mark.asyncio
async def test_create_compilation_minimal(client, clean_pool):
    ids = await _seed(n=2)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clips": [{"item_id": ids[0]}, {"item_id": ids[1]}]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "downloaded"
    assert len(body["clips"]["clips"]) == 2

    import uuid as _uuid

    async with session_factory() as session:
        item = await session.get(Item, _uuid.UUID(body["id"]))
        assert item is not None
        assert item.raw_path is None, "合集条目不该有 raw_path"
        assert item.clips["clips"][0]["transition"] == "cut"


@pytest.mark.asyncio
async def test_create_rejects_undownloaded_source(client, clean_pool):
    """片段没下载 → 422。不让用户建出一个注定拼不出来的合集。"""
    ids = await _seed(status="discovered", raw=False, n=2)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clips": [{"item_id": i} for i in ids]},
    )
    assert resp.status_code == 422
    assert "已下载" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_rejects_duplicate_clip(client, clean_pool):
    ids = await _seed(n=1)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clips": [{"item_id": ids[0]}, {"item_id": ids[0]}]},
    )
    assert resp.status_code == 422
    assert "重复" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_rejects_nested_compilation(client, clean_pool):
    """不能把已有合集再嵌进另一个合集——产物会递归。"""
    comp_ids = await _seed(n=1, clips={"clips": [{"item_id": str(uuid.uuid4())}]})
    ids = await _seed(n=2)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clips": [{"item_id": comp_ids[0]}, {"item_id": ids[0]}]},
    )
    assert resp.status_code == 422
    assert "嵌套" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_rejects_missing_source(client, clean_pool):
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clips": [{"item_id": str(uuid.uuid4())}, {"item_id": str(uuid.uuid4())}]},
    )
    assert resp.status_code == 422
    assert "片段不存在" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_requires_clips(client, clean_pool):
    resp = await client.post("/api/pipeline/compilations", json={"clips": []})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_create_with_clip_ids_only(client, clean_pool):
    """只给 clip_ids（不指定转场）→ 按顺序裸拼。"""
    ids = await _seed(n=3)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={"clip_ids": ids, "title": "三段合集"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "三段合集"
    assert [c["item_id"] for c in body["clips"]["clips"]] == ids


@pytest.mark.asyncio
async def test_create_with_transitions_and_outro(client, clean_pool):
    ids = await _seed(n=3)
    resp = await client.post(
        "/api/pipeline/compilations",
        json={
            "title": "带转场",
            "clips": [
                {"item_id": ids[0]},
                {"item_id": ids[1], "transition": "fade", "transition_s": 0.8},
                {"item_id": ids[2], "transition": "wipe", "transition_s": 0.5},
            ],
            "outro": {"enabled": True, "duration_s": 2.0, "subtitle": "完"},
        },
    )
    assert resp.status_code == 200
    plan = resp.json()["clips"]
    assert [c["transition"] for c in plan["clips"]] == ["cut", "fade", "wipe"]
    assert plan["outro"]["duration_s"] == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_update_reorder_and_transition(client, clean_pool):
    """拖拽排序 + 改转场：只改 clips，不动 status / raw_path。"""
    ids = await _seed(n=3)
    create = await client.post(
        "/api/pipeline/compilations", json={"clip_ids": ids}
    )
    cid = create.json()["id"]

    reordered = [ids[2], ids[0], ids[1]]
    resp = await client.put(
        f"/api/pipeline/compilations/{cid}",
        json={"clips": [{"item_id": i} for i in reordered]},
    )
    assert resp.status_code == 200
    assert [c["item_id"] for c in resp.json()["clips"]["clips"]] == reordered


@pytest.mark.asyncio
async def test_update_rejects_non_compilation(client, clean_pool):
    """对普通条目调合集更新 → 422（不是静默把普通条目变成合集）。"""
    ids = await _seed(n=1)
    resp = await client.put(
        f"/api/pipeline/compilations/{ids[0]}",
        json={"clips": [{"item_id": ids[0]}]},
    )
    assert resp.status_code == 422
    assert "不是合集" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_sources_lists_only_downloaded_non_compilation(client, clean_pool):
    """可作片段的候选：只有「已下载 + 有 raw + 非合集」的条目。

    四种条目各一条，逐个断言去留——比「种一堆再数总数」精确：
    后者只要有一条漏判，总数就可能仍然对得上（多一条+少一条互相抵消）。
    """
    good = await _seed(status="downloaded", raw=True, n=2)
    unscored = (await _seed(status="discovered", raw=True, n=1))[0]      # 未下载
    noraw = (await _seed(status="downloaded", raw=False, n=1))[0]        # 无 raw
    nested = (await _seed(                                            # 本身是合集
        status="downloaded", raw=True, n=1,
        clips={"clips": [{"item_id": str(uuid.uuid4())}]},
    ))[0]

    resp = await client.get("/api/pipeline/compilations/sources")
    assert resp.status_code == 200
    body = resp.json()
    got = {row["id"] for row in body}
    assert good[0] in got, f"已下载且有 raw 的条目应可作片段：返回 {len(got)} 条"
    assert good[1] in got
    assert unscored not in got, "未评分条目不该作为片段（raw 还没下下来）"
    assert noraw not in got, "没有 raw 的条目不该作为片段"
    assert nested not in got, "合集条目不该作为片段（防嵌套）"


@pytest.mark.asyncio
async def test_serialize_exposes_clips(client, clean_pool):
    """列表接口要暴露 clips——前端判断「这条是不是合集」的唯一契约。"""
    ids = await _seed(n=2)
    create = await client.post(
        "/api/pipeline/compilations", json={"clip_ids": ids, "title": "可序列化"}
    )
    cid = create.json()["id"]

    listing = await client.get("/api/pipeline/items", params={"status": "downloaded"})
    assert listing.status_code == 200
    rows = {r["id"]: r for r in listing.json()}
    assert cid in rows, "合集条目应出现在已下载列表"
    assert rows[cid]["clips"] is not None
    # 普通条目的 clips 恒为 None
    if ids[0] in rows:
        assert rows[ids[0]]["clips"] is None


def test_clips_column_maps_python_none_to_sql_null() -> None:
    """**JSONB none_as_null 回归**——本轮最隐蔽的一个生产 bug。

    `JSONB()` 默认把 Python `None` 序列化成 JSON `null` 写进列，于是判据
    `Item.clips.is_(None)`（= SQL `IS NULL`）**一条都不匹配**：新建的普通条目
    全被当成合集排除，合集编排界面一个片段都列不出来。

    症状与根因隔了三层（列表为空 → 看着像「没有可用的已下载条目」→
    查到库里明明有几千条），定位花了很久。所以把「模型声明里有
    none_as_null」直接钉成断言：谁把它去掉、或者新加一个 JSONB 列忘了写，
    这里立刻红。
    """
    col = Item.__table__.c.clips
    assert col.type.none_as_null is True, (
        "items.clips 必须 none_as_null=True——否则 Python None 存成 JSON null，"
        "`clips IS NULL` 匹配不到，合集候选列表恒空"
    )


@pytest.mark.asyncio
async def test_plain_item_is_listed_as_compilation_source(client, clean_pool):
    """**这条是上面那个 bug 的行为断言**：普通条目（clips 未设置）必须出现在
    候选里。JSONB 陷阱发作时它会消失——而症状看起来只是「列表空」，极易被
    误判成「库里真没有可用的已下载条目」。
    """
    ids = await _seed(status="downloaded", raw=True, n=1)
    resp = await client.get("/api/pipeline/compilations/sources")
    assert resp.status_code == 200
    assert ids[0] in {r["id"] for r in resp.json()}, (
        "普通条目没进候选列表——检查 items.clips 是否还带着 none_as_null"
    )
