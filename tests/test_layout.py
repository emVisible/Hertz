"""layout 域测试（超级 Markdown 模块，切片 D 后端一半，设计 §6）。

覆盖：
- CRUD 全路径：建 / 列表（不含 source_md 全文、updated_at 倒序）/ 读 / 局部改 / 删；
  改、读、删不存在的 id → 404。
- platform 枚举：非法值建/改 → 422。
- 导入 docs：正常读 + suggested_title；越界（../）/ 绝对路径 / 非 .md 一律 4xx。
- 导入 studio：正常读 final.md；坏 slug（..、/、\\）fail-closed 422；不存在 404。

共享 DB（hertz_test），本文件创建的 layouts 行在每条测试后清掉（D-181 惯例）。
"""

import pytest

from backend.config import settings
from backend.models.session import session_factory


@pytest.fixture(autouse=True)
async def _layout_cleanup():
    yield
    from sqlalchemy import delete

    from backend.models.layout import Layout, LayoutRevision

    async with session_factory() as session:
        # 版本表有 ON DELETE CASCADE，硬删稿件时会跟着走；但软删的稿**行还在**，
        # 所以这里两边都显式清，免得上一条用例的历史漏到下一条
        await session.execute(delete(LayoutRevision))
        await session.execute(delete(Layout))
        await session.commit()


def _payload(**over) -> dict:
    body = {
        "title": "测试排版稿",
        "source_md": "# 标题\n\n正文",
        "source_ref": "notes/hello.md",
        "platform": "wechat",
        "theme_id": "wechat-ink",
        "overrides": {"primary": "#ff0000"},
        "cover": {"enabled": True},
    }
    body.update(over)
    return body


async def _create(client, **over) -> dict:
    resp = await client.post("/api/layout", json=_payload(**over))
    assert resp.status_code == 200, resp.text
    return resp.json()


# ---------- CRUD ----------


@pytest.mark.asyncio
async def test_create_returns_full_layout(client, _layout_cleanup) -> None:
    data = await _create(client)
    assert data["id"]
    assert data["title"] == "测试排版稿"
    assert data["source_md"] == "# 标题\n\n正文"
    assert data["source_ref"] == "notes/hello.md"
    assert data["platform"] == "wechat"
    assert data["theme_id"] == "wechat-ink"
    assert data["overrides"] == {"primary": "#ff0000"}
    assert data["cover"] == {"enabled": True}
    assert data["created_at"] and data["updated_at"]


@pytest.mark.asyncio
async def test_create_defaults(client, _layout_cleanup) -> None:
    resp = await client.post("/api/layout", json={"title": "极简", "platform": "xhs"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["source_md"] == ""
    assert data["source_ref"] is None
    assert data["theme_id"] == ""
    assert data["overrides"] == {}
    assert data["cover"] == {}


@pytest.mark.asyncio
async def test_get_full_layout(client, _layout_cleanup) -> None:
    created = await _create(client)
    resp = await client.get(f"/api/layout/{created['id']}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == created["id"]
    assert data["source_md"] == "# 标题\n\n正文"


@pytest.mark.asyncio
async def test_list_excludes_source_md_and_orders_by_updated_desc(
    client, _layout_cleanup
) -> None:
    a = await _create(client, title="A")
    b = await _create(client, title="B")
    # 触碰 A 使其 updated_at 最新 → 列表 A 在前
    resp = await client.put(f"/api/layout/{a['id']}", json={"title": "A2"})
    assert resp.status_code == 200

    resp = await client.get("/api/layout")
    assert resp.status_code == 200
    items = resp.json()
    assert isinstance(items, list) and len(items) == 2
    assert [i["title"] for i in items] == ["A2", "B"]
    for item in items:
        assert "source_md" not in item
        # `deleted_at` 是 W2 回收站加的：列表行要能标出「这篇在回收站里」
        assert set(item) == {"id", "title", "platform", "theme_id", "updated_at", "deleted_at"}
    assert {i["id"] for i in items} == {a["id"], b["id"]}


@pytest.mark.asyncio
async def test_update_partial_fields(client, _layout_cleanup) -> None:
    created = await _create(client)
    resp = await client.put(
        f"/api/layout/{created['id']}",
        json={"source_md": "# 新", "platform": "zhihu", "overrides": {"fontSize": 16}},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["source_md"] == "# 新"
    assert data["platform"] == "zhihu"
    assert data["overrides"] == {"fontSize": 16}
    # 未提供的字段保持原值
    assert data["title"] == "测试排版稿"
    assert data["theme_id"] == "wechat-ink"
    assert data["cover"] == {"enabled": True}


@pytest.mark.asyncio
async def test_delete_layout(client, _layout_cleanup) -> None:
    created = await _create(client)
    resp = await client.delete(f"/api/layout/{created['id']}")
    assert resp.status_code == 200
    # 已删的稿按 404 处理：否则还能打开编辑、保存又把它写活，回收站形同虚设
    resp = await client.get(f"/api/layout/{created['id']}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_update_delete_missing_404(client, _layout_cleanup) -> None:
    import uuid

    missing = str(uuid.uuid4())
    assert (await client.get(f"/api/layout/{missing}")).status_code == 404
    assert (
        await client.put(f"/api/layout/{missing}", json={"title": "x"})
    ).status_code == 404
    assert (await client.delete(f"/api/layout/{missing}")).status_code == 404


@pytest.mark.asyncio
async def test_platform_invalid_rejected_422(client, _layout_cleanup) -> None:
    resp = await client.post("/api/layout", json=_payload(platform="weibo"))
    assert resp.status_code == 422
    created = await _create(client)
    resp = await client.put(f"/api/layout/{created['id']}", json={"platform": "weibo"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_platform_all_three_accepted(client, _layout_cleanup) -> None:
    for platform in ("wechat", "xhs", "zhihu"):
        data = await _create(client, platform=platform)
        assert data["platform"] == platform


# ---------- 导入：docs 空间 ----------


@pytest.fixture
def docs_root(tmp_path, monkeypatch):
    """隔离 docs 根（assets_root 指向 tmp_path），写完即弃。"""
    monkeypatch.setattr(
        "backend.routers.docs.runtime_config.load", lambda: {"assets_root": str(tmp_path)}
    )
    return tmp_path


@pytest.mark.asyncio
async def test_import_docs_reads_markdown(client, docs_root) -> None:
    (docs_root / "notes").mkdir()
    (docs_root / "notes" / "hello.md").write_text("# 你好世界\n\n正文段落", encoding="utf-8")
    resp = await client.get("/api/layout/import/docs", params={"path": "notes/hello.md"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["path"] == "notes/hello.md"
    assert data["content"] == "# 你好世界\n\n正文段落"
    assert data["suggested_title"] == "你好世界"


@pytest.mark.asyncio
async def test_import_docs_suggested_title_falls_back_to_stem(client, docs_root) -> None:
    (docs_root / "plain.md").write_text("没有一级标题的正文", encoding="utf-8")
    resp = await client.get("/api/layout/import/docs", params={"path": "plain.md"})
    assert resp.status_code == 200
    assert resp.json()["suggested_title"] == "plain"


@pytest.mark.asyncio
async def test_import_docs_rejects_out_of_root_paths(client, docs_root) -> None:
    # 越界（..）→ 403（与 docs.py containment 口径一致）
    resp = await client.get("/api/layout/import/docs", params={"path": "../secret.md"})
    assert resp.status_code == 403
    # 绝对路径 → 422
    resp = await client.get("/api/layout/import/docs", params={"path": "/etc/passwd"})
    assert resp.status_code == 422
    # 非 .md → 422
    (docs_root / "readme.txt").write_text("x", encoding="utf-8")
    resp = await client.get("/api/layout/import/docs", params={"path": "readme.txt"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_import_docs_missing_404(client, docs_root) -> None:
    resp = await client.get("/api/layout/import/docs", params={"path": "nope.md"})
    assert resp.status_code == 404


# ---------- 导入：Studio 产物 ----------


@pytest.fixture
def studio_root():
    root = settings.data_dir / "output" / "studio"
    root.mkdir(parents=True, exist_ok=True)
    return root


@pytest.mark.asyncio
async def test_import_studio_reads_final_md(client, studio_root) -> None:
    run_dir = studio_root / "2026-10-13-01"
    run_dir.mkdir()
    (run_dir / "final.md").write_text("# 成片文稿\n\n内容", encoding="utf-8")
    resp = await client.get("/api/layout/import/studio", params={"run": "2026-10-13-01"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["run"] == "2026-10-13-01"
    assert data["content"] == "# 成片文稿\n\n内容"
    assert data["suggested_title"] == "成片文稿"


@pytest.mark.asyncio
async def test_import_studio_suggested_title_falls_back_to_slug(client, studio_root) -> None:
    run_dir = studio_root / "run-x"
    run_dir.mkdir()
    (run_dir / "final.md").write_text("无标题正文", encoding="utf-8")
    resp = await client.get("/api/layout/import/studio", params={"run": "run-x"})
    assert resp.status_code == 200
    assert resp.json()["suggested_title"] == "run-x"


@pytest.mark.asyncio
async def test_import_studio_bad_slug_422(client, studio_root) -> None:
    for slug in ("..", "../x", "a/b", "a\\b", "a/../../etc"):
        resp = await client.get("/api/layout/import/studio", params={"run": slug})
        assert resp.status_code == 422, f"slug={slug!r} 应 fail-closed 422，实得 {resp.status_code}"


@pytest.mark.asyncio
async def test_import_studio_missing_404(client, studio_root) -> None:
    resp = await client.get("/api/layout/import/studio", params={"run": "no-such-run"})
    assert resp.status_code == 404


# ---------- W2 数据安全：回收站 + 版本历史 ----------


@pytest.mark.asyncio
async def test_delete_is_soft_and_recoverable(client, _layout_cleanup) -> None:
    """删除是**软删**：点错了还能捞回来。

    这一条是本组判据的底线。原来 DELETE 是硬删——点一下"删除"就没了，没有后悔药。
    """
    created = await _create(client, title="待删的稿")
    lid = created["id"]
    assert (await client.delete(f"/api/layout/{lid}")).status_code == 200

    # 默认列表里没了
    live = (await client.get("/api/layout")).json()
    assert lid not in [row["id"] for row in live]

    # 回收站里有
    trash = (await client.get("/api/layout", params={"deleted": "true"})).json()
    row = next(r for r in trash if r["id"] == lid)
    assert row["deleted_at"], "软删必须带删除时间（不然回答不了什么时候删的）"

    # 捞回来，内容原样
    restored = (await client.post(f"/api/layout/{lid}/restore")).json()
    assert restored["title"] == "待删的稿"
    assert restored["source_md"] == created["source_md"]
    assert restored["deleted_at"] is None
    live_again = (await client.get("/api/layout")).json()
    assert lid in [r["id"] for r in live_again]


@pytest.mark.asyncio
async def test_restore_is_idempotent(client, _layout_cleanup) -> None:
    created = await _create(client)
    lid = created["id"]
    await client.delete(f"/api/layout/{lid}")
    first = (await client.post(f"/api/layout/{lid}/restore")).status_code
    second = (await client.post(f"/api/layout/{lid}/restore")).status_code
    assert first == 200 and second == 200
    assert (await client.get(f"/api/layout/{lid}")).status_code == 200


@pytest.mark.asyncio
async def test_purge_requires_deleted_first(client, _layout_cleanup) -> None:
    """真删只对回收站里的稿开放，且是真删——没有"30 天自动清空"这种默认。"""
    created = await _create(client)
    lid = created["id"]
    assert (await client.post(f"/api/layout/{lid}/purge")).status_code == 400

    await client.delete(f"/api/layout/{lid}")
    assert (await client.post(f"/api/layout/{lid}/purge")).status_code == 200
    assert (await client.get("/api/layout", params={"deleted": "true"})).json() == []


@pytest.mark.asyncio
async def test_update_snapshots_the_previous_state(client, _layout_cleanup) -> None:
    """每次更新都落一份**改之前**的快照——用户改砸了要能退回去。"""
    created = await _create(client, source_md="# 原稿")
    lid = created["id"]

    await client.put(f"/api/layout/{lid}", json={"source_md": "# 改坏了"})

    hist = (await client.get(f"/api/layout/{lid}/revisions")).json()["revisions"]
    assert hist, "更新后一份历史都没有"
    assert hist[0]["preview"].startswith("# 原稿"), "存的是改之后的内容——那退回去没意义"

    # 回到那一版
    seq = hist[0]["seq"]
    back = (await client.post(f"/api/layout/{lid}/revisions/{seq}/restore")).json()
    assert back["source_md"] == "# 原稿"


@pytest.mark.asyncio
async def test_revision_restore_is_itself_reversible(client, _layout_cleanup) -> None:
    """"回到旧版"本身也是一次改动，所以要**先给当前内容存一份**。

    否则用户点一次"回到旧版"就又不可逆了——这正是回收站存在的理由。
    """
    created = await _create(client, source_md="# v1")
    lid = created["id"]
    await client.put(f"/api/layout/{lid}", json={"source_md": "# v2"})

    hist = (await client.get(f"/api/layout/{lid}/revisions")).json()["revisions"]
    v1_seq = hist[0]["seq"]
    await client.post(f"/api/layout/{lid}/revisions/{v1_seq}/restore", json=None)
    assert (await client.get(f"/api/layout/{lid}")).json()["source_md"] == "# v1"

    after = (await client.get(f"/api/layout/{lid}/revisions")).json()["revisions"]
    # 最新的那份应当是 v2（回退前的当前内容）
    assert after[0]["preview"].startswith("# v2")
    await client.post(f"/api/layout/{lid}/revisions/{after[0]['seq']}/restore")
    assert (await client.get(f"/api/layout/{lid}")).json()["source_md"] == "# v2"


@pytest.mark.asyncio
async def test_revision_seq_increments_and_history_is_bounded(client, _layout_cleanup) -> None:
    created = await _create(client)
    lid = created["id"]
    for i in range(5):
        await client.put(f"/api/layout/{lid}", json={"source_md": f"# 第{i}版"})
    hist = (await client.get(f"/api/layout/{lid}/revisions", params={"limit": 100})).json()
    seqs = [r["seq"] for r in hist["revisions"]]
    assert seqs == sorted(seqs, reverse=True), "历史应当按 seq 倒序"
    assert len(set(seqs)) == len(seqs), "seq 不能重复（同一秒两次保存会撞时间戳）"


@pytest.mark.asyncio
async def test_delete_also_snapshots(client, _layout_cleanup) -> None:
    """删除前也要留一份：万一用户发现自己删错了，捞回来时内容还在。"""
    created = await _create(client, source_md="# 会被删掉的正文")
    lid = created["id"]
    await client.delete(f"/api/layout/{lid}")
    hist = (await client.get(f"/api/layout/{lid}/revisions")).json()["revisions"]
    assert hist and hist[0]["preview"].startswith("# 会被删掉的正文")


@pytest.mark.asyncio
async def test_updated_deleted_layout_is_404(client, _layout_cleanup) -> None:
    """已删的稿不许被更新：否则一次自动保存就能把它写活。"""
    created = await _create(client)
    lid = created["id"]
    await client.delete(f"/api/layout/{lid}")
    resp = await client.put(f"/api/layout/{lid}", json={"title": "偷偷复活"})
    assert resp.status_code == 404
