"""Wave 3 orchestration tests: CRUD + full 14-phase run with a fake LLM."""

import asyncio
import re
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from backend.ai.router import AIRouter
from backend.ai.types import ChatMessage
from backend.factory.registry import ServiceRegistry
from backend.models.plan import PhaseRun, Plan, WorkflowRun
from backend.models.session import session_factory

FAKE_ARTICLE = (
    "本文主题是城市夜行者的生存美学。\n\n"
    "第 2 小节：观察。街道在十一点之后换了一副面孔，灯光从广告退成路灯，"
    "声音从车流退成脚步。最好的素材永远在白天与黑夜的缝隙里。\n\n"
    "第 3 小节：行动。不要等待灵感，去走，去看，去记。"
    "每条街都有它的语法，而你的工作是学会阅读它。"
    "留白是节奏的一部分，删除是写作的一部分。"
    "最终留下值得留下的内容，其他的都删掉。\n\n"
    "（这是一个超过八十字节的测试正文，用于通过质量门禁检查，"
    "同时模拟真实 agent 产出的长度与结构。）"
)


class FakeLLM:
    """Streaming LLM fake: yields canned responses per chat call."""

    def __init__(self, responses: list[str], chunk_delay: float = 0.0) -> None:
        self.responses = list(responses)
        self.calls: list[list[ChatMessage]] = []
        self.chunk_delay = chunk_delay

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        self.calls.append(messages)
        text = self.responses.pop(0) if self.responses else FAKE_ARTICLE
        for ch in text:
            if self.chunk_delay:
                await asyncio.sleep(self.chunk_delay)
            yield ch

    async def aclose(self) -> None:
        pass


class FailingLLM:
    """LLM fake whose every call raises — exercises the package fallback."""

    async def chat_stream(self, messages, *, temperature=0.7, max_tokens=4096):
        raise RuntimeError("provider down")

    async def aclose(self) -> None:
        pass


@pytest.fixture
async def fake_ai(client, tmp_path):
    """Point registry AI + output dir at a fake LLM and a temp dir.

    Depends on ``client`` so the lifespan initialize (real providers) runs
    first and our fake AI replaces it afterwards.
    """
    registry = ServiceRegistry.get()
    original_ai = registry.ai
    registry.ai = AIRouter(llm=FakeLLM([FAKE_ARTICLE] * 12), image=None, tts=None)
    registry.files.output_dir = tmp_path / "output"
    registry.files.ensure_dir(registry.files.output_dir)
    from backend.pipeline.collectors.reddit import FakeRedditCollector

    registry.pipeline.engine.collector = FakeRedditCollector([])
    yield registry
    registry.ai = original_ai
    registry.files.output_dir = Path("output")


async def _create(client, path: str, body: dict) -> dict:
    resp = await client.post(f"/api/{path}", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_crew_crud(client, fake_ai) -> None:
    """团队 CRUD：role_keys 引用角色库，序列化展开角色配置。"""
    crew = await _create(client, "crews", {"name": "内容小组"})
    assert crew["name"] == "内容小组"
    # 默认团队空角色；角色从库中选
    assert crew["role_keys"] == []
    assert crew["roles"] == []

    # 从角色库选 3 个角色组成团队
    roles = (await client.get("/api/roles")).json()
    keys = [r["key"] for r in roles[:3]]
    updated = await client.put(
        f"/api/crews/{crew['id']}", json={"role_keys": keys}
    )
    assert updated.json()["role_keys"] == keys
    assert [r["key"] for r in updated.json()["roles"]] == keys
    assert updated.json()["roles"][0]["role_name"]  # 展开出角色名

    listing = await client.get("/api/crews")
    assert listing.status_code == 200
    assert any(c["id"] == crew["id"] for c in listing.json())

    renamed = await client.put(f"/api/crews/{crew['id']}", json={"name": "改名小组"})
    assert renamed.json()["name"] == "改名小组"

    resp = await client.delete(f"/api/crews/{crew['id']}")
    assert resp.status_code == 200
    assert (await client.get(f"/api/crews/{crew['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_brief_crud(client, fake_ai) -> None:
    brief = await _create(client, "briefs", {"name": "美食栏目", "platform_id": "bilibili"})
    assert "创意策略模板" in brief["content"]  # default template seeded
    assert brief["platform_id"] == "bilibili"

    updated = await client.put(
        f"/api/briefs/{brief['id']}", json={"content": "# 新策略\n\n直接写作。"}
    )
    assert updated.json()["content"] == "# 新策略\n\n直接写作。"


@pytest.mark.asyncio
async def test_plan_crud_and_validation(client, fake_ai) -> None:
    plan = await _create(client, "plans", {"name": "标准流程"})
    assert len(plan["phase_order"]) == 8
    assert sum(1 for p in plan["phase_order"] if p["enabled"]) == 7  # content_pipeline 默认禁用
    assert plan["phase_order"][0]["key"] == "build_brief"

    # invalid phase key rejected
    resp = await client.post(
        "/api/plans", json={"name": "坏计划", "phase_order": [{"key": "nope", "enabled": True}]}
    )
    assert resp.status_code == 422

    # duplicate key rejected
    dup = [{"key": "writer", "enabled": True}, {"key": "writer", "enabled": True}]
    resp = await client.post("/api/plans", json={"name": "重复", "phase_order": dup})
    assert resp.status_code == 422

    # legacy keys (wave7 精简合并前的工序) 平滑迁移到新工序
    legacy = [
        {"key": "scout", "enabled": True},  # 已删除 → 直接去掉
        {"key": "analyst", "enabled": True},  # 已删除 → 直接去掉
        {"key": "growth_director", "enabled": True},
        {"key": "outreach_specialist", "enabled": True},
        {"key": "community_manager", "enabled": True},
        {"key": "writer", "enabled": True},
    ]
    resp = await client.post("/api/plans", json={"name": "旧计划迁移", "phase_order": legacy})
    assert resp.status_code == 200, resp.text
    migrated = resp.json()["phase_order"]
    assert [p["key"] for p in migrated] == ["distribution", "writer"]  # 3 个旧分发合一
    # 读取（序列化）时同样归一化
    resp = await client.get(f"/api/plans/{resp.json()['id']}")
    assert [p["key"] for p in resp.json()["phase_order"]] == ["distribution", "writer"]

    # 二次精简（wave8）：preflight/image_gen/quality_gate 并入相邻工序
    legacy2 = [
        {"key": "preflight", "enabled": True},
        {"key": "image_gen", "enabled": True},
        {"key": "quality_gate", "enabled": True},
    ]
    resp = await client.post("/api/plans", json={"name": "二次精简迁移", "phase_order": legacy2})
    assert resp.status_code == 200, resp.text
    assert [p["key"] for p in resp.json()["phase_order"]] == ["build_brief", "visual_director", "package"]

    # 旧计划中别名项与显式项并存（preflight + build_brief）不得报重复
    legacy3 = [
        {"key": "preflight", "enabled": True},
        {"key": "build_brief", "enabled": True},
        {"key": "director", "enabled": True},
    ]
    resp = await client.post("/api/plans", json={"name": "别名撞车", "phase_order": legacy3})
    assert resp.status_code == 200, resp.text
    assert [p["key"] for p in resp.json()["phase_order"]] == ["build_brief", "director"]
    # 读取（序列化）路径同样不崩
    resp = await client.get(f"/api/plans/{resp.json()['id']}")
    assert resp.status_code == 200
    assert [p["key"] for p in resp.json()["phase_order"]] == ["build_brief", "director"]

    # update phase order (subset)
    subset = [{"key": "build_brief", "enabled": True}, {"key": "director", "enabled": True}]
    resp = await client.put(f"/api/plans/{plan['id']}", json={"phase_order": subset})
    assert len(resp.json()["phase_order"]) == 2

    # explicit null / empty values must be applied (clearable fields)
    resp = await client.put(
        f"/api/plans/{plan['id']}",
        json={"crew_id": None, "description": "", "mode": "text"},
    )
    body = resp.json()
    assert body["crew_id"] is None
    assert body["description"] == ""

    # omitted keys must NOT overwrite stored values
    resp = await client.put(f"/api/plans/{plan['id']}", json={"name": "改名"})
    body = resp.json()
    assert body["name"] == "改名"
    assert len(body["phase_order"]) == 2


@pytest.mark.asyncio
async def test_phase_editing_archive_and_restore(client, fake_ai) -> None:
    # 工序库：可查看/编辑 agent 配置（完全维护）
    palette = (await client.get("/api/phases")).json()
    assert len(palette) == 8
    assert any(p["key"] == "distribution" for p in palette)
    assert not any(p["key"] == "scout" for p in palette)  # 已精简
    # wave8 二次精简：preflight/image_gen/quality_gate 已移除
    assert not any(p["key"] in ("preflight", "image_gen", "quality_gate") for p in palette)

    writer = next(p for p in palette if p["key"] == "writer")
    assert writer["role"] and writer["method"] and writer["style"]
    assert writer["model"] == ""  # 内置工序不锁模型：跟随全局默认（Studio 主模型）

    updated = await client.put(
        "/api/phases/writer",
        json={"role": "狂想作家", "method": "只写没有废话的句子", "style": ["锋利"]},
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["role"] == "狂想作家"
    assert body["method"] == "只写没有废话的句子"
    assert body["style"] == ["锋利"]

    # 内置工序可软删除（归档），自定义工序硬删除
    deleted = await client.delete("/api/phases/writer")
    assert deleted.status_code == 200
    palette_after = (await client.get("/api/phases")).json()
    assert not any(p["key"] == "writer" for p in palette_after)

    custom = await _create(client, "phases", {"name": "临时工序"})
    await client.delete(f"/api/phases/{custom['key']}")
    assert not any(p["key"] == custom["key"] for p in (await client.get("/api/phases")).json())

    # 恢复默认：内置全部归来
    restored = await client.post("/api/phases/restore-defaults")
    assert restored.status_code == 200
    palette_restored = (await client.get("/api/phases")).json()
    assert any(p["key"] == "writer" for p in palette_restored)
    writer_back = next(p for p in palette_restored if p["key"] == "writer")
    assert writer_back["method"].startswith("1. 先列骨架")  # 出厂 method 为结构化多行步骤
    assert writer_back["model"] == ""  # 恢复默认同样不锁模型


@pytest.mark.asyncio
async def test_plan_with_archived_phase_skips_run(client, fake_ai) -> None:
    """计划里引用了已被归档的工序时，运行应跳过而非崩溃。"""
    await client.delete("/api/phases/director")  # 归档 director

    subset = [
        {"key": "build_brief", "enabled": True},
        {"key": "director", "enabled": True},
        {"key": "writer", "enabled": True},
    ]
    plan = await _create(client, "plans", {"name": "含归档工序"})
    await client.put(f"/api/plans/{plan['id']}", json={"phase_order": subset})

    resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题"})
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]
    for _ in range(100):
        detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
        if detail["status"] != "running":
            break
        await asyncio.sleep(0.1)
    assert detail["status"] == "completed", detail.get("error")
    # director 被跳过，只有 build_brief/writer 记录
    keys = [p["key"] for p in detail["phases"]]
    assert "director" not in keys
    assert "writer" in keys
    # 恢复，避免污染后续测试
    await client.post("/api/phases/restore-defaults")


@pytest.mark.asyncio
async def test_legacy_run_folds_removed_phases(client, fake_ai) -> None:
    """老计划里已移除/历史工序应在运行时折叠到现行工序，而不是被跳过。

    用户场景：wave7 前的 14 道老工序（preflight/scout/image_gen/quality_gate…）
    触发执行后应迁移为现行 8 工序——别名目标（distribution）必须真正执行，
    已删除工序不再以「工序已移除」形式出现。
    """
    legacy_order = [
        {"key": "preflight", "enabled": True},
        {"key": "build_brief", "enabled": True},
        {"key": "scout", "enabled": True},
        {"key": "analyst", "enabled": True},
        {"key": "director", "enabled": True},
        {"key": "writer", "enabled": True},
        {"key": "visual_director", "enabled": True},
        {"key": "image_gen", "enabled": True},
        {"key": "editor", "enabled": True},
        {"key": "growth_director", "enabled": True},
        {"key": "outreach_specialist", "enabled": True},
        {"key": "community_manager", "enabled": True},
        {"key": "quality_gate", "enabled": True},
        {"key": "package", "enabled": True},
    ]
    plan = await _create(client, "plans", {"name": "老计划"})
    # 直接落到 DB，绕过保存时的前置归一化，模拟历史数据
    async with session_factory() as session:
        row = await session.get(Plan, uuid.UUID(plan["id"]))
        row.phase_order = legacy_order
        await session.commit()
    assert len((await client.get("/api/plans/" + plan["id"])).json()["phase_order"]) == 7

    resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题"})
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]
    for _ in range(100):
        detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
        if detail["status"] != "running":
            break
        await asyncio.sleep(0.1)
    assert detail["status"] == "completed", detail.get("error")
    keys = [p["key"] for p in detail["phases"]]

    # 别名目标被执行：growth_director/outreach_specialist/community_manager → distribution
    assert "distribution" in keys, keys
    # 已删除工序不再被逐个跳过（preflight 折叠进 build_brief，image_gen 折叠进 visual_director…）
    for removed in ("preflight", "scout", "analyst", "image_gen", "growth_director",
                    "outreach_specialist", "community_manager", "quality_gate"):
        assert removed not in keys, keys

    # 计划在数据库里已被持久化为现行工序
    stored = (await client.get("/api/plans/" + plan["id"])).json()["phase_order"]
    assert [p["key"] for p in stored] == [
        "build_brief", "director", "writer", "visual_director",
        "editor", "distribution", "package",
    ]


@pytest.mark.asyncio
async def test_full_run_produces_final_md(client, fake_ai) -> None:
    crew = await _create(client, "crews", {"name": "内容小组"})
    brief = await _create(client, "briefs", {"name": "栏目策略", "platform_id": "bilibili"})
    plan = await _create(
        client,
        "plans",
        {"name": "全流程", "crew_id": crew["id"], "brief_id": brief["id"], "mode": "text"},
    )

    resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "城市夜行者"})
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["id"]

    run = None
    for _ in range(100):
        detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
        if detail["status"] in ("completed", "failed", "cancelled"):
            run = detail
            break
        await asyncio.sleep(0.1)
    assert run is not None, "run never finished"
    assert run["status"] == "completed", run.get("error")

    # all 7 enabled phases recorded
    assert len(run["phases"]) == 7  # content_pipeline 默认禁用
    assert all(p["status"] == "completed" for p in run["phases"])

    # final.md exists and is non-empty
    files = (await client.get(f"/api/studio/runs/{run_id}/files")).json()["files"]
    assert "final.md" in files
    assert "writer.md" in files

    final_resp = await client.get(f"/api/studio/runs/{run_id}/files/final.md")
    assert final_resp.status_code == 200
    assert len(final_resp.text) > 100

    # 策略分析阶段走了 LLM 分析（非模板拼接），产出的 brief.md 不含模板文案
    brief_resp = await client.get(f"/api/studio/runs/{run_id}/files/brief.md")
    assert brief_resp.status_code == 200
    assert "Creative Strategy" not in brief_resp.text or "素材本质" in brief_resp.text

    # 产物目录结构化命名：studio/YYYY-MM-DD-NN，且文件可读（路径一致性）
    assert run["output_dir"].startswith("studio/")
    assert re.match(r"^studio/\d{4}-\d{2}-\d{2}-\d{2}$", run["output_dir"]), run["output_dir"]
    detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
    assert detail["output_dir"] == run["output_dir"]
    assert detail["phases"] and len(detail["phases"]) == 7

    # DB rows persisted
    async with session_factory() as session:
        wr = await session.get(WorkflowRun, run_id)
        assert wr is not None and wr.status == "completed"
        rows = await session.execute(
            select(PhaseRun).where(PhaseRun.run_id == run_id)
        )
        assert len(rows.scalars().all()) == 7


def test_agent_prompt_bans_copy_and_orders_thinking() -> None:
    """agent 提示词必须包含思考协议：禁止照搬重排原文 + 先读懂再写作。"""
    from backend.ai.prompts.agent import (
        _THINKING_PROTOCOL,
        BRIEF_SYSTEM,
        SYNTHESIS_SYSTEM,
        build_agent_messages,
        build_brief_messages,
        build_synthesis_messages,
    )

    assert "思考协议" in _THINKING_PROTOCOL
    assert "不允许逐句复述原文" in _THINKING_PROTOCOL

    sys_msg, user_msg = build_agent_messages(
        agent={"role": "writer", "method": "写", "style": []},
        phase_name="内容创作",
        topic="知乎长文：城市夜行者生存美学",
        brief_excerpt="",
        platform_id="",
        prior="导演分析：留白是节奏",
        output_file="writer.md",
    )
    assert "思考协议" in sys_msg.content
    assert "主素材" in user_msg.content
    assert "前序产物" in user_msg.content
    # 前序产物不再被截断成 800 字残片
    long_prior = "字" * 5000
    _, user2 = build_agent_messages(
        agent={"role": "writer", "method": "写", "style": []},
        phase_name="内容创作",
        topic="主题",
        brief_excerpt="",
        platform_id="",
        prior=long_prior,
        output_file="writer.md",
    )
    assert "字" * 5000 in user2.content

    # brief 分析要求产出有决策价值的五大节，而不是复述素材
    assert "决策价值" in BRIEF_SYSTEM
    b_sys, b_user = build_brief_messages(
        topic="知乎文章全文", brief_excerpt="", platform_id="zhihu"
    )
    assert "素材本质" in b_user.content
    assert "中心主张" in b_user.content
    assert "结构骨架" in b_user.content
    assert "不要复述素材原文" in b_user.content

    # 终审合成要求重写而非拼接
    assert "拼接" in SYNTHESIS_SYSTEM
    s_sys, _ = build_synthesis_messages(
        topic="t", title="tit", brief_excerpt="", platform_id="", body="草稿"
    )
    assert "素材" in s_sys.content or "草稿" in s_sys.content


@pytest.mark.asyncio
async def test_single_flight_guard(client, fake_ai) -> None:
    plan = await _create(client, "plans", {"name": "单飞"})
    first = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题"})
    assert first.status_code == 200
    second = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题2"})
    assert second.status_code == 409

    # wait for the run to finish so later tests aren't affected
    run_id = first.json()["id"]
    for _ in range(100):
        detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
        if detail["status"] != "running":
            break
        await asyncio.sleep(0.1)


@pytest.mark.asyncio
async def test_cancel_interrupts_run(client, tmp_path) -> None:
    plan = await _create(client, "plans", {"name": "取消流程"})
    # Slow fake LLM so the run is still in-flight when we cancel.
    registry = ServiceRegistry.get()
    original_ai = registry.ai
    registry.ai = AIRouter(llm=FakeLLM([FAKE_ARTICLE], chunk_delay=0.02), image=None, tts=None)
    try:
        resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题"})
        run_id = resp.json()["id"]
        cancelled = await client.post(f"/api/studio/runs/{run_id}/cancel")
        assert cancelled.status_code == 200
        cancelled_seen = False
        for _ in range(50):
            detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
            if detail["status"] != "running":
                assert detail["status"] == "cancelled"
                cancelled_seen = True
                break
            await asyncio.sleep(0.05)
        assert cancelled_seen, "run not cancelled"
    finally:
        registry.ai = original_ai


@pytest.mark.asyncio
async def test_studio_events_stream(client, fake_ai) -> None:
    plan = await _create(client, "plans", {"name": "事件流"})

    seen: list[dict] = []
    hub = ServiceRegistry.get().events
    stop = asyncio.Event()

    async def collector():
        async with hub.subscribe("studio", replay=False) as queue:
            while not stop.is_set():
                try:
                    seen.append(await asyncio.wait_for(queue.get(), timeout=0.2))
                except TimeoutError:
                    continue

    task = asyncio.create_task(collector())
    resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "主题"})
    run_id = resp.json()["id"]
    for _ in range(100):
        detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
        if detail["status"] != "running":
            break
        await asyncio.sleep(0.1)
    await asyncio.sleep(0.2)
    stop.set()
    await task

    types = [e["type"] for e in seen]
    assert "phase_start" in types
    assert "phase_done" in types
    assert "run_done" in types
    assert types.count("phase_start") == types.count("phase_done") == 7
    run_done = next(e for e in seen if e["type"] == "run_done")
    assert run_done["status"] == "completed"


@pytest.mark.asyncio
async def test_package_fallback_when_llm_synthesis_fails(client, tmp_path) -> None:
    """AI synthesis crash must fall back to local assembly (regression: await bug)."""
    registry = ServiceRegistry.get()
    original_ai = registry.ai
    original_dir = registry.files.output_dir
    registry.ai = AIRouter(llm=FailingLLM(), image=None, tts=None)
    registry.files.output_dir = tmp_path / "output"
    registry.files.ensure_dir(registry.files.output_dir)
    try:
        plan = await _create(client, "plans", {"name": "降级打包"})
        subset = [
            {"key": "build_brief", "enabled": True},
            {"key": "package", "enabled": True},
        ]
        await client.put(f"/api/plans/{plan['id']}", json={"phase_order": subset})

        resp = await client.post(f"/api/plans/{plan['id']}/run", json={"input": "城市夜行者"})
        assert resp.status_code == 200, resp.text
        run_id = resp.json()["id"]
        for _ in range(100):
            detail = (await client.get(f"/api/studio/runs/{run_id}")).json()
            if detail["status"] != "running":
                break
            await asyncio.sleep(0.1)
        assert detail["status"] == "completed", detail.get("error")

        final_resp = await client.get(f"/api/studio/runs/{run_id}/files/final.md")
        assert final_resp.status_code == 200
        assert len(final_resp.text) > 50
        assert "# " in final_resp.text
        assert "主题" in final_resp.text
    finally:
        registry.ai = original_ai
        registry.files.output_dir = original_dir


@pytest.mark.asyncio
async def test_eventhub_replays_history_to_late_subscriber() -> None:
    from backend.infrastructure.events import EventHub

    hub = EventHub(replay_size=10)
    # History is only retained while a topic has live subscribers; events
    # published to an unsubscribed topic are dropped (no unbounded growth).
    hub.publish("studio", {"type": "phase_start", "phase": "preflight"})
    assert "studio" not in hub._history

    seen: list[dict] = []
    async with hub.subscribe("studio") as queue:
        hub.publish("studio", {"type": "phase_start", "phase": "preflight"})
        hub.publish("studio", {"type": "phase_done", "phase": "preflight", "status": "completed"})
        # a second, late subscriber replays what it missed
        seen_late: list[dict] = []
        async with hub.subscribe("studio") as queue2:
            for _ in range(2):
                seen_late.append(await asyncio.wait_for(queue2.get(), timeout=1))
        assert [e["type"] for e in seen_late] == ["phase_start", "phase_done"]
        # drain what the first subscriber already queued, then take the live event
        seen.append(await asyncio.wait_for(queue.get(), timeout=1))
        seen.append(await asyncio.wait_for(queue.get(), timeout=1))
        hub.publish("studio", {"type": "log", "message": "live"})
        seen.append(await asyncio.wait_for(queue.get(), timeout=1))

    assert [e["type"] for e in seen] == ["phase_start", "phase_done", "log"]
    # history is dropped once the topic has no subscribers left
    assert "studio" not in hub._history


@pytest.mark.asyncio
async def test_role_library_crud(client, fake_ai) -> None:
    """角色库 CRUD + 团队引用角色（v4.1：角色=纯 MD 内容实体）。"""
    roles = (await client.get("/api/roles")).json()
    assert len(roles) >= 5  # 默认 5 内置角色
    assert any(r["key"] == "director" and r["role_name"] == "创意总监" for r in roles)
    # 内置角色执行配置已并入 MD description
    director = next(r for r in roles if r["key"] == "director")
    assert "方法论" in director["description"]

    # 自定义角色（纯 MD）
    resp = await client.post(
        "/api/roles",
        json={"key": "translator", "name": "翻译", "role_name": "译者", "description": "# 译者\n\n直译优先，保持原意。"},
    )
    assert resp.status_code == 200, resp.text
    role = resp.json()
    assert role["key"] == "translator"
    assert "直译优先" in role["description"]

    # 更新角色
    resp = await client.put(f"/api/roles/{role['id']}", json={"description": "# 译者\n\n意译优先。"})
    assert resp.status_code == 200
    assert "意译优先" in resp.json()["description"]

    # 团队引用该角色 → 序列化展开
    resp = await client.post("/api/crews", json={"name": "翻译团队", "role_keys": ["translator"]})
    assert resp.status_code == 200, resp.text
    team = resp.json()
    assert team["roles"][0]["key"] == "translator"
    assert team["roles"][0]["role_name"] == "译者"

    # 引擎 agents_map：角色只提供扮演名（执行配置回退工序库）
    from backend.factory.registry import ServiceRegistry

    agents = await ServiceRegistry.get().crews.agents_map(team["id"])
    assert agents["translator"]["role"] == "译者"
    assert "method" not in agents["translator"]

    # 非法 key 拒绝
    resp = await client.post("/api/roles", json={"key": "Bad Key!", "name": "坏"})
    assert resp.status_code == 422

    await client.delete(f"/api/crews/{team['id']}")
    await client.delete(f"/api/roles/{role['id']}")


@pytest.mark.asyncio
async def test_buff_system(client, fake_ai) -> None:
    """Buff 库 CRUD + 计划持久 + 运行时覆盖 + 注入解析。"""
    # 内置 buff 种子
    buffs = (await client.get("/api/buffs")).json()
    assert any(b["key"] == "human_touch" and b["kind"] == "lightweight" for b in buffs)
    assert any(b["key"] == "storyteller" and b["kind"] == "heavy" for b in buffs)
    assert any(b["category"] == "random" for b in buffs)

    # 自定义 buff
    resp = await client.post(
        "/api/buffs",
        json={"key": "my_tone", "name": "我的语气", "kind": "lightweight", "effect": "每段先给结论。"},
    )
    assert resp.status_code == 200, resp.text
    buff = resp.json()
    assert buff["key"] == "my_tone"

    # 非法 kind 拒绝
    resp = await client.post("/api/buffs", json={"key": "bad", "name": "x", "kind": "nope"})
    assert resp.status_code == 422

    # 计划持久 buff
    resp = await client.post("/api/plans", json={"name": "Buff 计划", "buff_keys": ["human_touch"]})
    assert resp.status_code == 200, resp.text
    plan = resp.json()
    assert plan["buff_keys"] == ["human_touch"]

    # 运行时覆盖：resolve_effects 解析（含 random 抽取）
    from backend.orchestration.buffs import BuffService

    svc = BuffService()
    fx = await svc.resolve_effects(["human_touch", "my_tone"])
    assert [b["key"] for b in fx] == ["human_touch", "my_tone"]
    fx_random = await svc.resolve_effects(["random"])
    assert len(fx_random) == 2  # random 池抽 2 个
    assert all(b["category"] == "random" for b in fx_random)
    # 每次随机不同（大概率）
    fx_random2 = await svc.resolve_effects(["random"])
    assert [b["key"] for b in fx_random] != [b["key"] for b in fx_random2]

    # 空 = 无注入
    assert await svc.resolve_effects([]) == []

    await client.delete(f"/api/plans/{plan['id']}")
    await client.delete(f"/api/buffs/{buff['id']}")
