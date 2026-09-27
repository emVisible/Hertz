"""Phase 4.4 地基回哺：阶段输入指纹 + 同 run 内防重放。"""

import uuid

import pytest
from sqlalchemy import select

from backend.ai.router import AIRouter
from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore
from backend.models.plan import PhaseRun, Plan, WorkflowRun
from backend.models.session import session_factory
from backend.orchestration.engine import PhaseEngine, PhaseResult, phase_input_hash
from backend.orchestration.phases import PHASE_INDEX
from tests.test_orchestration import FakeLLM


def test_phase_input_hash_stable_and_sensitive() -> None:
    from backend.ai.types import ChatMessage

    m = [ChatMessage(role="user", content="hi")]
    assert phase_input_hash(m, None) == phase_input_hash(m, None)
    assert phase_input_hash(m, "a") != phase_input_hash(m, "b")
    assert phase_input_hash(m, None) != phase_input_hash(
        [ChatMessage(role="user", content="hi!")], None)


@pytest.mark.asyncio
async def test_same_run_reuses_unchanged_phase(client, tmp_path) -> None:
    llm = FakeLLM(["甲" * 100])
    files = FileStore(data_dir=tmp_path / "data")
    engine = PhaseEngine(files=files, hub=EventHub(),
                         ai=AIRouter(llm=llm, image=None, tts=None))
    engine._prompt_templates = {}
    engine._buff_effects = []
    engine._depth_effect = ""
    # prior 取自 run_dir 会随写盘变化（第一次写后第二次的输入真变了）——
    # 此处固定 prior 以孤立验证"同输入复用"机制本身
    async def _fixed_prior(_run_dir) -> str:
        return ""

    engine._prior_excerpt = _fixed_prior  # type: ignore[method-assign]
    async with session_factory() as session:
        plan = Plan(name="t", phase_order=[])
        session.add(plan)
        await session.flush()
        run = WorkflowRun(plan_id=plan.id, output_dir=f"studio/{uuid.uuid4().hex[:8]}")
        session.add(run)
        await session.commit()
        run_id = run.id
    run_dir = files.output_root() / f"studio/{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=True)

    fake_run = type("R", (), {"id": run_id})()
    phase = PHASE_INDEX["director"]
    r1 = PhaseResult(key="director", name=phase.name, status="completed")
    await engine._run_agent(fake_run, "director", phase, run_dir, "主题", "", {}, 1, 1, r1)
    assert r1.output_file == "director.md" and not r1.reused
    assert len(llm.calls) == 1
    await engine._save_phase(run_id, "director", r1)

    r2 = PhaseResult(key="director", name=phase.name, status="completed")
    await engine._run_agent(fake_run, "director", phase, run_dir, "主题", "", {}, 1, 1, r2)
    assert r2.reused is True and r2.output_file == "director.md"
    assert len(llm.calls) == 1  # 未发生第二次 LLM 调用

    # 换主题 → 指纹变化 → 重新调用
    r3 = PhaseResult(key="director", name=phase.name, status="completed")
    await engine._run_agent(fake_run, "director", phase, run_dir, "另一个主题", "", {}, 1, 1, r3)
    assert r3.reused is False
    assert len(llm.calls) == 2

    async with session_factory() as session:
        row = (await session.execute(
            select(PhaseRun).where(PhaseRun.run_id == run_id, PhaseRun.phase_key == "director")
        )).scalar_one()
        assert row.output_json and row.output_json.get("input_hash") == r1.input_hash
