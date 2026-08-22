"""绕过评分直接下载（v0.11.10）：省 API 余额场景——discovered 条目
跳过评分直接进入 downloaded。契约：

1. 单条 download_one 默认仍拒绝 discovered（409，评分先行语义不变）
2. skip_score=1 放行 discovered → downloaded（text_only 走无媒体直通路径）
3. 批量 run?step=download&unscored=1 只拉 discovered（不碰 scored）
4. unscored 对其他步骤无效（score 正常执行）

全部走 text_only 条目 + Fake LLM + 本地资源，不触碰真实网络。
"""

import asyncio

import pytest

from backend.models.item import Item
from backend.models.session import session_factory


@pytest.fixture(autouse=True)
async def _cleanup_dls_items():
    """本文件条目 source_id 均以 dls- 前缀——测试后清除。

    conftest 仅 session 级建库、无 per-test 清表：直下产生的
    downloaded/scored 残留会被后续 chain 测试抢先 produce 进 queued，
    挤掉其 `_wait_items(n=1)` 首个匹配（StopIteration）。"""
    yield
    from sqlalchemy import delete

    async with session_factory() as session:
        await session.execute(delete(Item).where(Item.source_id.like("dls-%")))
        await session.commit()


async def _mk_item(status: str, source_id: str, title: str) -> str:
    async with session_factory() as session:
        row = Item(
            status=status, source="reddit", source_id=source_id, title=title,
            item_type="text_only", selftext="正文内容",
        )
        session.add(row)
        await session.commit()
        return str(row.id)


@pytest.mark.asyncio
async def test_download_one_rejects_discovered_without_skip(client) -> None:
    """评分先行语义保持：不带 skip_score 时 discovered 不可下载（409）。"""
    item_id = await _mk_item("discovered", "dls-1", "未评分不可直下")
    resp = await client.post(f"/api/pipeline/items/{item_id}/download")
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_download_one_skip_score_moves_to_downloaded(client) -> None:
    """skip_score=1：discovered 直下成功 → downloaded；产物目录已分配。"""
    item_id = await _mk_item("discovered", "dls-2", "跳过评分直下")
    resp = await client.post(f"/api/pipeline/items/{item_id}/download?skip_score=1")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "downloaded"
    async with session_factory() as session:
        row = await session.get(Item, __import__("uuid").UUID(item_id))
        assert row is not None and row.status == "downloaded"
        assert row.output_dir  # 文字产线也分配产物目录


@pytest.mark.asyncio
async def test_download_batch_unscored_picks_discovered_only(client) -> None:
    """run?step=download&unscored=1：只处理 discovered；scored 条目不被误下。"""
    disc = await _mk_item("discovered", "dls-3", "批量直下-未评分")
    scored = await _mk_item("scored", "dls-4", "已评分不动")
    scored_id = scored
    resp = await client.post("/api/pipeline/run?step=download&limit=5&unscored=1")
    assert resp.status_code == 200 and resp.json()["status"] == "queued"

    deadline = asyncio.get_running_loop().time() + 30
    done = False
    while asyncio.get_running_loop().time() < deadline:
        jobs = (await client.get("/api/pipeline/jobs")).json().get("jobs", [])
        hit = next((j for j in jobs if j.get("job") == "download"), None)
        if hit and hit.get("status") in ("completed", "failed"):
            done = True
            break
        await asyncio.sleep(0.3)
    assert done, "download(unscored) job 未在时限内完成"

    async with session_factory() as session:
        import uuid as _uuid

        d_row = await session.get(Item, _uuid.UUID(disc))
        s_row = await session.get(Item, _uuid.UUID(scored_id))
        assert d_row is not None and d_row.status == "downloaded"
        assert s_row is not None and s_row.status == "scored"


@pytest.mark.asyncio
async def test_unscored_flag_ignored_for_other_steps(client) -> None:
    """unscored 仅对 download 生效：score 步骤带 unscored=1 正常入队执行
    （不 422/409），discovered 条目照常走评分。"""
    await _mk_item("discovered", "dls-5", "评分不受影响")
    # Fake LLM 下 score 可能 502（provider 缺失）或 200——关键是入队而非状态校验失败
    resp = await client.post("/api/pipeline/run?step=score&limit=5&unscored=1")
    assert resp.status_code == 200 and resp.json()["status"] == "queued"
    deadline = asyncio.get_running_loop().time() + 30
    while asyncio.get_running_loop().time() < deadline:
        jobs = (await client.get("/api/pipeline/jobs")).json().get("jobs", [])
        hit = next((j for j in jobs if j.get("job") == "score"), None)
        if hit and hit.get("status") in ("completed", "failed"):
            break
        await asyncio.sleep(0.3)
