"""Pipeline 域反 AI 内容资产测试（v0.8 拆分自 test_pipeline_governance）。

覆盖：AI 调和工程师/Finetune 工序/debuff 四件套/反 AI 策略与策略组/
33 条铁律 reference 机制/深度档位库。
"""

import re
from pathlib import Path

import pytest

from backend.models.item import Item, ItemStatus
from backend.models.session import session_factory


@pytest.fixture(autouse=True)
async def _clean_items():
    """拆分文件自清理：这些测试创建的 Item 只为本文件服务，不污染共享库。"""
    yield
    from sqlalchemy import delete

    async with session_factory() as session:
        await session.execute(delete(Item))
        await session.commit()

# ---------- 深度档位库（v0.3.10 可维护化） ----------


@pytest.mark.asyncio
async def test_depth_levels_seed_and_crud(client) -> None:
    """深度库：内置五档 seed + CRUD + 恢复出厂。"""
    # seed 五档
    resp = await client.get("/api/depths")
    assert resp.status_code == 200
    levels = resp.json()
    keys = [lv["key"] for lv in levels]
    assert set(keys) == {"terse", "concise", "normal", "detailed", "deep"}
    normal = next(lv for lv in levels if lv["key"] == "normal")
    assert normal["effect"] == ""  # 正常档不注入

    # 新建自定义档
    resp = await client.post(
        "/api/depths", json={"key": "mega", "name": "超详细", "effect": "【深】写透"}
    )
    assert resp.status_code == 200
    created = resp.json()
    assert created["builtin"] is False

    # 更新档指令
    resp = await client.put(
        f"/api/depths/{created['id']}", json={"effect": "【深】写透改版"}
    )
    assert resp.status_code == 200
    assert resp.json()["effect"] == "【深】写透改版"

    # 删除自定义档
    resp = await client.delete(f"/api/depths/{created['id']}")
    assert resp.status_code == 200

    # 恢复出厂：只剩内置五档
    resp = await client.post("/api/depths/restore-defaults")
    assert resp.status_code == 200
    assert resp.json()["count"] == 5
    resp = await client.get("/api/depths")
    assert len(resp.json()) == 5


@pytest.mark.asyncio
async def test_depth_effect_db_priority(client) -> None:
    """engine 深度指令 DB 优先（自定义档即时生效；内置档以代码为准 seed 同步）。"""
    from backend.orchestration.depths import DepthService

    service = DepthService()
    # 默认内置
    assert "极简" in await service.effect_for("terse")
    assert await service.effect_for("normal") == ""
    # 自定义档：DB 指令即时生效
    created = await service.create(
        key="mega", name="超详细", effect="【新深】写透。"
    )
    assert (await service.effect_for("mega")) == "【新深】写透。"
    # 更新自定义档即时生效
    await service.update(created["id"], effect="【新深】写透改版。")
    assert (await service.effect_for("mega")) == "【新深】写透改版。"
    # 内置档被 seed 同步回代码版本（内置以代码为准）
    await service.restore_defaults()  # 还原
    assert "极简" in await service.effect_for("terse")


@pytest.mark.asyncio
async def test_updated_at_refreshes_on_requeue(client) -> None:
    """最近操作排序要素（v0.3.12）：打回审核/打回预处理刷新 updated_at。"""
    from datetime import UTC, datetime, timedelta

    async with session_factory() as session:
        item = Item(
            status=ItemStatus.PUBLISHED, source="reddit", source_id="upd-1", title="已发布",
        )
        session.add(item)
        await session.commit()
        item_id = item.id
        # 把 updated_at 拨回过去，模拟老数据
        old = datetime.now(UTC) - timedelta(days=3)
        row = await session.get(Item, item_id)
        row.updated_at = old
        await session.commit()

    # 发布打回审核 → updated_at 刷新为现在
    resp = await client.post(f"/api/pipeline/items/{item_id}/requeue")
    assert resp.status_code == 200
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.updated_at is not None
        assert (row.updated_at - old).total_seconds() > 3600  # 明显刷新

    # 审核打回预处理 → 再次刷新
    resp = await client.post(f"/api/pipeline/items/{item_id}/back-to-prep")
    assert resp.status_code == 200
    async with session_factory() as session:
        row = await session.get(Item, item_id)
        assert row.status == "scored"
    # 序列化暴露 updated_at（列表排序要素）
    resp = await client.get("/api/pipeline/items?status=scored&limit=10")
    assert resp.status_code == 200
    serialized = resp.json()
    assert all("updated_at" in i for i in serialized)


# ---------- AI 味去除（v0.6：反 AI 专家 + AIFantune 工序 + debuff 深化） ----------


def test_finetune_phase_registered() -> None:
    """AIFantune 工序：注册 + 默认顺序启用 + 反 AI 专家角色可派生。"""
    from backend.orchestration.phases import DEFAULT_PHASE_ORDER, PHASE_INDEX

    phase = PHASE_INDEX.get("finetune")
    assert phase is not None
    assert phase.phase_type == "agent"
    assert phase.role == "AI 调和工程师"  # v0.7 角色切换
    assert phase.output_file == "finetune.md"
    assert "均值回归" in phase.method  # 原理注入
    assert "不得编造" in phase.method  # no-fabrication 铁律
    # 默认顺序中在 editor 后、distribution 前（用户可拖拽调整）
    keys = [p["key"] for p in DEFAULT_PHASE_ORDER]
    assert keys.index("finetune") > keys.index("editor")
    assert keys.index("finetune") < keys.index("distribution")


def test_anti_ai_debuffs_seeded() -> None:
    """反 AI debuff 四件套：词汇/句式/吹胀/痕迹。"""
    from backend.orchestration.buffs import BUILTIN_DEBUFFS

    keys = {b["key"]: b for b in BUILTIN_DEBUFFS}
    assert "no_ai_phrases" in keys and keys["no_ai_phrases"]["kind"] == "heavy"
    for key in ("no_ai_structure", "no_ai_hype", "no_ai_artifact"):
        assert key in keys, f"missing debuff {key}"
        assert keys[key]["kind"] == "heavy"
    assert "系动词回避" in keys["no_ai_structure"]["effect"]
    assert "均值回归" in keys["no_ai_hype"]["effect"]
    assert "知识截止免责" in keys["no_ai_artifact"]["effect"]


@pytest.mark.asyncio
async def test_package_prefers_finetune(client, tmp_path, monkeypatch) -> None:
    """打包正文优先 finetune.md（内容微调工序启用时真正影响成品）。"""
    from backend.orchestration.engine import PhaseEngine

    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "writer.md").write_text("这是 AI 写的第一版正文。\n", encoding="utf-8")
    (run_dir / "finetune.md").write_text("这是人去 AI 味后的正文。\n", encoding="utf-8")

    engine = PhaseEngine(files=None, hub=None, ai=None)  # type: ignore[arg-type]
    engine.files = _FakeFiles()
    engine.ai = None

    # 兜底路径（skip_gate）验证 body 来源；ai=None 时走 _assemble 拼接
    from backend.orchestration.engine import PhaseResult

    result = PhaseResult(key="package", name="打包", status="completed")
    try:
        await engine._package(
            run_dir, "主题", "", result,
            mode="text", skip_gate=True,
        )
    except Exception:  # noqa: BLE001 — 拼接路径可能因缺素材报错，检查产物优先逻辑
        pass
    final = (
        (run_dir / "final.md").read_text(encoding="utf-8")
        if (run_dir / "final.md").exists()
        else ""
    )
    assert "人去 AI 味后的正文" in final
    assert "AI 写的第一版正文" not in final


class _FakeFiles:
    """Engine 文件存取的桩：直接映射 tmp 路径（包内最小实现）。"""

    async def safe_read(self, path):
        import asyncio

        def _read() -> bytes:
            if Path(path).exists():
                return Path(path).read_bytes()
            return b""

        return await asyncio.to_thread(_read)

    async def atomic_write(self, path, content):
        import asyncio

        def _write() -> None:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(content, encoding="utf-8")

        await asyncio.to_thread(_write)



def test_finetune_legacy_alias() -> None:
    """旧计划 ai_fantune 引用平滑迁移到 finetune（v0.6 更名）。"""
    from backend.orchestration.phases import LEGACY_PHASE_ALIASES

    assert LEGACY_PHASE_ALIASES["ai_fantune"] == "finetune"


# ---------- 策略组 / 反 AI 资产（v0.7） ----------


@pytest.mark.asyncio
async def test_brief_groups_crud_and_seed(client) -> None:
    """策略组：内置反 AI 策略组 seed + CRUD + 组优先挂载。"""
    # seed：内置反 AI 策略 + 反 AI 策略组
    briefs = (await client.get("/api/briefs")).json()
    anti = next((b for b in briefs if b["name"] == "反 AI 策略"), None)
    assert anti is not None
    assert "均值回归" in anti["content"]  # 超长策略核心原理
    assert "不得编造" in anti["content"]  # no-fabrication 铁律
    assert "stop-slop" in anti["content"] or "五维" in anti["content"]

    groups = (await client.get("/api/brief-groups")).json()
    g = next((x for x in groups if x["name"] == "反 AI 策略组"), None)
    assert g is not None
    assert str(anti["id"]) in g["brief_ids"]

    # CRUD：新建 + 更新 + 删除
    resp = await client.post(
        "/api/brief-groups",
        json={"name": "测试组", "description": "d", "brief_ids": [str(anti["id"])]},
    )
    assert resp.status_code == 200
    gid = resp.json()["id"]
    resp = await client.put(
        f"/api/brief-groups/{gid}", json={"name": "测试组2"}
    )
    assert resp.status_code == 200 and resp.json()["name"] == "测试组2"
    resp = await client.delete(f"/api/brief-groups/{gid}")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_brief_group_resolve_and_plan_mount(client) -> None:
    """引擎拼接注入 + 计划挂载（组优先于单 brief）。"""
    from backend.models.brief import Brief, BriefGroup
    from backend.orchestration.brief_groups import BriefGroupService

    async with session_factory() as session:
        b1 = Brief(name="策略一", content="内容一。")
        b2 = Brief(name="策略二", content="内容二。")
        session.add_all([b1, b2])
        await session.commit()
        group = BriefGroup(name="组合", brief_ids=[str(b1.id), str(b2.id)])
        session.add(group)
        await session.commit()
        gid, bid1 = group.id, b1.id

    svc = BriefGroupService()
    content = await svc.resolve_content(gid)
    assert "## 策略：策略一" in content and "内容一。" in content
    assert "## 策略：策略二" in content

    # 计划挂组：create 带 brief_group_id
    resp = await client.post(
        "/api/plans",
        json={"name": "组挂载测试", "brief_group_id": str(gid), "brief_id": str(bid1)},
    )
    assert resp.status_code == 200
    plan = resp.json()
    assert plan["brief_group_id"] == str(gid)
    assert plan["brief_id"] == str(bid1)  # 两者并存，引擎按组优先


@pytest.mark.asyncio
async def test_ai_harmonizer_role_seeded(client) -> None:
    """内置角色 AI 调和工程师 seed。"""
    roles = (await client.get("/api/roles")).json()
    harmonizer = next((r for r in roles if r["key"] == "ai_harmonizer"), None)
    assert harmonizer is not None
    assert harmonizer["role_name"] == "AI 调和工程师"
    assert "工作准则如下" in harmonizer["description"]  # 去索引：内容自包含
    assert "Wikipedia" not in harmonizer["description"]  # 不再引用外部文档


# ---------- 33 条铁律 reference 机制（v0.7.2） ----------


@pytest.mark.asyncio
async def test_reference_injection_and_path_guard(tmp_path) -> None:
    """reference 文件读取注入 + ../ 越界拒绝。"""
    from backend.orchestration.engine import PhaseEngine

    rules = tmp_path / "reference" / "rules.md"
    rules.parent.mkdir(parents=True)
    rules.write_text("# 铁律\n\n1. 具体。", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("越界", encoding="utf-8")

    engine = PhaseEngine(files=_FakeFiles2(tmp_path), hub=None, ai=None)  # type: ignore[arg-type]

    ok = await engine._read_reference("reference/rules.md")
    assert "铁律" in ok

    escaped = await engine._read_reference("../secret.txt")
    assert escaped == ""  # 越界拒绝


class _FakeFiles2:
    """指向 tmp_path 的最小 FileStore 桩（data_dir 可被 _read_reference 使用）。"""

    def __init__(self, root) -> None:
        self.data_dir = root

    async def safe_read(self, path):
        import asyncio

        def _read() -> bytes:
            if Path(path).exists():
                return Path(path).read_bytes()
            return b""

        return await asyncio.to_thread(_read)


def test_33_rules_file_generated() -> None:
    """33 条铁律文件存在且覆盖 33 个编号。"""

    path = Path(__file__).resolve().parent.parent / "data" / "reference" / "33-anti-ai-rules.md"
    assert path.exists(), "33-anti-ai-rules.md 缺失"
    content = path.read_text(encoding="utf-8")

    numbers = [int(m) for m in re.findall(r"^### (\d+)\.", content, re.M)]
    assert len(numbers) == 33, f"应为 33 条，实际 {len(numbers)}"
    assert set(numbers) == set(range(1, 34))  # humanizer 原始编号（1-19、26-33、20-25）


def test_de_indexed_assets() -> None:
    """去索引化：注入内容不再引用外部文档。"""
    from backend.orchestration.anti_ai_assets import ANTI_AI_BRIEF_CONTENT
    from backend.orchestration.buffs import BUILTIN_DEBUFFS
    from backend.orchestration.phases import PHASE_INDEX

    assert "Wikipedia" not in ANTI_AI_BRIEF_CONTENT
    assert "Wikipedia" not in PHASE_INDEX["finetune"].description
    assert "Wikipedia" not in PHASE_INDEX["finetune"].method
    for buff in BUILTIN_DEBUFFS:
        assert "Wikipedia" not in buff["effect"]
