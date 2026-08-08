"""PhaseEngine — sequential executor for the built-in phases.

Runs a plan's enabled phases in order inside a per-run output directory
``output/studio/{run_id}/``. Agent phases call the AI router and write
``<phase_key>.md``; system phases are implemented here. Progress and
results are broadcast via EventHub (topics ``studio:{run_id}`` and
``studio``) and persisted to workflow_runs / phase_runs.
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from uuid import UUID

from sqlalchemy import select

from backend.ai.prompts.agent import (
    build_agent_messages,
    build_brief_messages,
    build_synthesis_messages,
)
from backend.ai.router import AIRouter
from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore
from backend.models.brief import Brief
from backend.models.plan import PhaseRun, Plan, WorkflowRun
from backend.models.session import session_factory
from backend.orchestration.plans import PlanService

logger = logging.getLogger(__name__)

_STYLE_BLOCK_RE = re.compile(r"^## Style \d+[^\n]*\n(.+?)(?=^## |\Z)", re.MULTILINE | re.DOTALL)
# Phase outputs consumed by the package step
_PACKAGE_SOURCES = (
    ("editor.md", "审校意见"),
    ("distribution.md", "分发策略"),
)

# System phases and the artifact files they produce (package gate checks these)
_SYSTEM_ARTIFACTS = {
    "build_brief": "brief.md",
}


@dataclass
class PhaseResult:
    key: str
    name: str
    status: str  # success | failed | cancelled
    duration_ms: int = 0
    error: str = ""
    output_file: str = ""  # relative path inside the run dir, "" = none

    def to_dict(self) -> dict:
        return {
            "key": self.key,
            "name": self.name,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "error": self.error,
            "output_file": self.output_file,
        }


@dataclass
class RunResult:
    status: str  # completed | failed | cancelled
    error: str = ""
    output_dir: str = ""
    final_md: str = ""
    phases: list[PhaseResult] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "error": self.error,
            "output_dir": self.output_dir,
            "final_md": self.final_md,
            "phases": [p.to_dict() for p in self.phases],
        }


class PhaseEngine:
    def __init__(self, files: FileStore, hub: EventHub, ai: AIRouter | None = None) -> None:
        self.phases = None  # PhasesService (set by caller); index resolved lazily
        self.files = files
        self.hub = hub
        self.ai = ai
        self._prompt_templates: dict[str, str] = {}  # v2.4 模板快照（run 时刷新）
        self.buff_keys: list[str] = []  # v5.0 buff 引用（studio 设置）
        self._buff_effects: list[dict] = []  # 解析后的注入指令（run 时刷新）

    # ---------- public ----------

    async def run(
        self,
        run: WorkflowRun,
        plan: Plan,
        topic: str,
        brief: Brief | None = None,
        agents: dict[str, dict] | None = None,
    ) -> RunResult:
        run_dir = self._run_dir(run)
        await asyncio.to_thread(run_dir.mkdir, parents=True, exist_ok=True)
        agents = agents or {}
        brief_excerpt = (brief.content if brief and brief.content else "") or ""
        # v5.3：平台语境由策略正文承载（策略 MD 已涵盖平台调性），
        # 不再单独注入 platform_id 标签——保留空值走提示词默认。
        platform_id = ""

        await self.files.atomic_write(run_dir / "user-input.md", topic)

        # v2.4 提示词模板库：运行开始时取一次模板快照（DB 覆盖 → 出厂默认），
        # 传给各 prompt 构建函数。取不到（无 DB）则用出厂默认，不阻塞运行。
        try:
            from backend.ai.prompts.template_service import prompt_templates

            self._prompt_templates = {
                t["key"]: t["content"] for t in await prompt_templates.list()
            }
        except Exception:  # noqa: BLE001 — 模板库不可用时回退出厂默认
            self._prompt_templates = {}

        # v5.0 buff 注入：解析 buff keys → 注入指令（random 从随机池抽）。
        # 取不到（无 DB）则空，不阻塞运行。
        try:
            from backend.orchestration.buffs import BuffService

            self._buff_effects = await BuffService().resolve_effects(self.buff_keys)
            if self._buff_effects:
                self._emit(
                    "log", None,
                    message="Buff: " + ", ".join(b["name"] for b in self._buff_effects),
                )
        except Exception:  # noqa: BLE001 — buff 不可用时不影响运行
            self._buff_effects = []

        # 归一化历史/已移除工序（防御：start() 已持久化，这里兜底任何入口）。
        # 已移除工序被剔除，别名折叠到现行工序——不会再出现"工序已移除"跳过行。
        raw_order = plan.phase_order or []
        normalized = PlanService.validate_phase_order(raw_order)
        order = normalized if normalized is not None else raw_order
        phase_order = [p for p in order if p.get("enabled")]
        total = len(phase_order)
        results: list[PhaseResult] = []
        cancelled = False

        for index, item in enumerate(phase_order, start=1):
            key = item["key"]
            phase = (await self._phase_index()).get(key)
            if phase is None:
                # 防御兜底：工序被归档/删除但仍在计划中——静默跳过，
                # 不产生 "工序已移除" 日志噪音（已移除的工序本来就不该出现）
                continue
            self._emit("phase_start", run.id, phase=key, name=phase.name, index=index, total=total)
            start = time.perf_counter()
            result = PhaseResult(key=key, name=phase.name, status="completed")
            try:
                if phase.phase_type == "agent":
                    await self._run_agent(
                        phase.key, phase, run_dir, topic, brief_excerpt,
                        platform_id, agents, index, total, result,
                    )
                    if phase.key == "visual_director":
                        # 配图渲染并入视觉工序（原 image_gen 职责）：
                        # Style 块就绪后立即渲染，text 模式/无图像服务时自动跳过
                        await self._render_visual(run_dir, result)
                else:
                    await self._run_system(
                        phase.key, phase, run_dir, topic, brief_excerpt,
                        platform_id, plan, result,
                    )
            except asyncio.CancelledError:
                result.status = "cancelled"
                result.error = "cancelled by user"
                cancelled = True
            except TimeoutError:
                result.status = "failed"
                result.error = f"timeout after {phase.timeout}s"
            except Exception as exc:  # noqa: BLE001 — persist any phase failure
                logger.exception("phase %s crashed", phase.key)
                result.status = "failed"
                result.error = str(exc)[:500]

            result.duration_ms = int((time.perf_counter() - start) * 1000)
            results.append(result)
            self._emit(
                "phase_done", run.id, phase=key, name=phase.name, status=result.status,
                duration_ms=result.duration_ms, error=result.error or None,
            )
            await self._save_phase(run.id, key, result)
            if result.status != "completed" and not cancelled:
                break
            if cancelled:
                break

        # Force package even after failures so a final.md exists (Mojito behavior).
        final_text = ""
        pkg = (await self._phase_index()).get("package")
        if not cancelled and pkg is not None and not any(
            r.key == "package" and r.status == "completed" for r in results
        ):
            self._emit(
                "phase_start", run.id, phase="package", name=pkg.name,
                index=total + 1, total=total + 1,
            )
            start = time.perf_counter()
            result = PhaseResult(key="package", name=pkg.name, status="completed")
            try:
                # 失败兜底路径：跳过终检，仍产出 final.md（Mojito 行为）
                final_text = await self._package(
                    run_dir, topic, brief_excerpt, platform_id, result,
                    mode=plan.mode, phase_order=plan.phase_order, skip_gate=True,
                )
            except Exception as exc:  # noqa: BLE001
                logger.exception("package phase crashed")
                result.status = "failed"
                result.error = str(exc)[:500]
            result.duration_ms = int((time.perf_counter() - start) * 1000)
            results.append(result)
            self._emit(
                "phase_done", run.id, phase="package", name=pkg.name, status=result.status,
                duration_ms=result.duration_ms, error=result.error or None,
            )
            await self._save_phase(run.id, "package", result)

        if not cancelled and all(r.status == "completed" for r in results):
            status = "completed"
        elif cancelled:
            status = "cancelled"
        else:
            status = "failed"
        error = next((r.error for r in results if r.status != "completed"), "")
        if not cancelled and status == "failed":
            error = error or "one or more phases failed"
        if not cancelled and status == "completed" and not final_text:
            raw = await self.files.safe_read(run_dir / "final.md")
            final_text = raw.decode("utf-8", "replace") if raw else ""

        result = RunResult(
            status=status,
            error=error,
            output_dir=str(run_dir),
            final_md=final_text,
            phases=results,
        )
        self._emit("run_done", run.id, status=status, error=error or None, output_dir=str(run_dir))
        return result

    # ---------- agent phases ----------

    async def _run_agent(
        self,
        key: str,
        phase,
        run_dir: Path,
        topic: str,
        brief_excerpt: str,
        platform_id: str,
        agents: dict[str, dict],
        index: int,
        total: int,
        result: PhaseResult,
    ) -> None:
        if self.ai is None or not self.ai.llm_available:
            raise RuntimeError("LLM provider not configured — agent phases unavailable")
        agent = agents.get(key, {})
        # 配置解析链：crew 优先 → 工序库（phase）→ 出厂默认（PHASES 已 seed 进
        # 工序库）。timeout/retries 同样走这条链，声明与执行一致（AXIOM §1.2）。
        timeout_s = int(agent.get("timeout") or getattr(phase, "timeout", 0) or 300)
        prior = await self._prior_excerpt(run_dir)
        role = agent.get("role") or getattr(phase, "role", "") or phase.name
        method = agent.get("method") or getattr(phase, "method", "") or "直接交付成品"
        style = agent.get("style") or list(getattr(phase, "style", None) or [])
        # 模型解析：crew/工序显式指定（model 非空）→ TaskRouter 精确匹配；
        # 未配置（内置工序出厂 model 为空）→ 按角色回退（main=Studio 全局选择）。
        # 空串视为未配置——这正是 Studio 模型下拉真正生效的路径。
        configured_model = (agent.get("model") or getattr(phase, "model", "") or "").strip()
        self._emit("log", None, message=f"[{index}/{total}] → Agent: {key} ({role})")
        messages = build_agent_messages(
            agent={**agent, "role": role, "method": method, "style": style},
            phase_name=phase.name,
            topic=topic,
            brief_excerpt=brief_excerpt,
            platform_id=platform_id,
            prior=prior,
            output_file=f"{key}.md",
            templates=self._prompt_templates,
            buffs=self._buff_effects,
        )
        text = ""
        # Declared retries must have an executor: transient LLM failures get
        # a couple of exponential-backoff attempts before the phase fails
        # (AXIOM §1.2 — declared semantics match executed mechanics).
        retries = int(agent.get("retries") if agent.get("retries") is not None
                      else getattr(phase, "retries", 0) or 0)
        for attempt in range(retries + 1):
            try:
                async with asyncio.timeout(timeout_s):
                    text = await self.ai.chat_messages(
                        messages, model_key=configured_model or None
                    )
                break
            except Exception as exc:  # noqa: BLE001 — retryable transient failure
                if attempt >= retries:
                    raise
                msg = f"[{key}] attempt {attempt + 1} failed, retrying: {exc}"
                self._emit("log", None, message=msg)
                await asyncio.sleep(1.5 * 2**attempt)
        text = (text or "").strip()
        if not text:
            raise RuntimeError("agent returned empty output")
        await self.files.atomic_write(run_dir / f"{key}.md", text)
        result.output_file = f"{key}.md"

    # ---------- system phases ----------



    async def _phase_index(self) -> dict:
        """合并工序索引（内置 + 用户自定义）；无 service 时回退内置。"""
        if self.phases is not None:
            return await self.phases.index()
        from backend.orchestration.phases import PHASE_INDEX

        return PHASE_INDEX

    async def _run_system(
        self,
        key: str,
        phase,
        run_dir: Path,
        topic: str,
        brief_excerpt: str,
        platform_id: str,
        plan: Plan,
        result: PhaseResult,
    ) -> None:
        # system phase 也输出进度日志：长等待（LLM 分析 40s+）期间用户能看到"在跑"
        self._emit("log", None, message=f"[{phase.name}] 开始…")
        if key == "build_brief":
            await self._build_brief(run_dir, topic, brief_excerpt, platform_id, result)
        elif key == "package":
            await self._package(
                run_dir, topic, brief_excerpt, platform_id, result,
                mode=plan.mode, phase_order=plan.phase_order,
            )
        elif key == "content_pipeline":
            await self._content_pipeline(run_dir, result)
        else:  # pragma: no cover — unknown system key
            raise RuntimeError(f"unknown system phase '{key}'")

    async def _build_brief(
        self, run_dir: Path, topic: str, brief_excerpt: str, platform_id: str, result: PhaseResult
    ) -> None:
        # 环境状态并入策略分析（原 preflight 职责）：LLM/图像可用性一目了然
        llm = bool(self.ai is not None and self.ai.llm_available)
        image = bool(self.ai is not None and self.ai.image_available)
        env_line = (
            f"- 环境: LLM {'可用' if llm else '未配置'}"
            f" / 图像生成 {'可用' if image else '未配置'}\n"
        )
        # 策略分析是"理解"环节：LLM 可用时对输入做真实分析，而不是把主题复述一遍
        text = ""
        if self.ai is not None and self.ai.llm_available:
            messages = build_brief_messages(
                topic=topic, brief_excerpt=brief_excerpt, platform_id=platform_id,
                templates=self._prompt_templates,
            )
            try:
                async with asyncio.timeout(120):
                    # 策略分析走 fast 角色（便宜快速模型）：它只是"读懂输入产出分析"，
                    # 不需要 main 的强推理——避免 V3.2 长上下文 40s+ 卡住第一个阶段
                    candidate = (await self.ai.chat_messages(messages, role="fast")).strip()
                if len(candidate) > 50:
                    text = candidate
            except Exception:  # noqa: BLE001 — fall back to template
                logger.exception("brief analysis failed, falling back to template")
        if not text:
            text = (
                f"# Creative Strategy\n\n## 主题\n{topic}\n\n"
                f"## 策略\n\n{brief_excerpt or '（无关联策略，使用默认：真实、有用、有审美）'}\n"
            )
        await self.files.atomic_write(run_dir / "brief.md", env_line + text)
        result.output_file = "brief.md"
        if not llm:
            self._emit("log", None, message="警告: LLM 未配置，agent 阶段将失败")

    async def _render_visual(self, run_dir: Path, result: PhaseResult) -> None:
        # 原 image_gen 职责：visual_director 产出 Style 块后自动渲染配图；
        # 无图像服务/无 Style 块时优雅跳过，不阻塞主流程。
        images_dir = run_dir / "images"
        await asyncio.to_thread(images_dir.mkdir, parents=True, exist_ok=True)
        if self.ai is None or not self.ai.image_available:
            await self.files.atomic_write(
                images_dir / "skipped.md", "# 配图生成已跳过\n\n未配置图像生成服务（comfyui）。\n"
            )
            self._emit("log", None, message="配图生成跳过: 未配置图像服务")
            return
        raw = await self.files.safe_read(run_dir / "visual_director.md")
        if not raw:
            skip = "# 配图生成已跳过\n\nvisual_director.md 缺失。\n"
            await self.files.atomic_write(images_dir / "skipped.md", skip)
            return
        text = raw.decode("utf-8", "replace")
        blocks = [b.strip() for b in _STYLE_BLOCK_RE.findall(text)]
        prompts = [b for b in blocks if b and not b.startswith("```")]
        if not prompts:
            skip = "# 配图生成已跳过\n\nvisual_director.md 中没有 Style 块。\n"
            await self.files.atomic_write(images_dir / "skipped.md", skip)
            self._emit("log", None, message="配图生成跳过: 无 Style 块")
            return
        made: list[str] = []
        for i, prompt in enumerate(prompts, start=1):
            try:
                image = await self.ai.generate_image(prompt, width=1024, height=1024)
            except Exception:  # noqa: BLE001 — 单张失败不阻塞整次运行
                logger.exception("image generation failed for prompt %d", i)
                self._emit("log", None, message=f"配图 {i}/{len(prompts)} 生成失败，已跳过")
                continue
            made.append(image.path.name)
            self._emit(
                "log", None, message=f"配图 {i}/{len(prompts)} 生成: {image.path.name}"
            )
        manifest = "\n".join(f"- {name}" for name in made) + "\n"
        await self.files.atomic_write(images_dir / "manifest.md", manifest)
        result.output_file = "images/"

    async def _quality_gate(
        self, run_dir: Path, phase_order: list[dict] | None = None
    ) -> None:
        # 终检并入打包（原 quality_gate 职责）：按 plan 实际启用的阶段动态检查，
        # 每个启用的 agent 阶段必须产出 {key}.md，系统阶段要求核心产物。
        enabled = [p["key"] for p in (phase_order or []) if p.get("enabled")]
        expected: set[str] = set()
        for key in enabled:
            phase = (await self._phase_index()).get(key)
            if phase is None:
                continue
            if phase.phase_type == "agent":
                expected.add(f"{key}.md")
            elif key in _SYSTEM_ARTIFACTS:
                expected.add(_SYSTEM_ARTIFACTS[key])
        missing = [k for k in sorted(expected) if not (run_dir / k).exists()]
        if "writer.md" in expected:
            raw = await self.files.safe_read(run_dir / "writer.md")
            if raw and len(raw) < 80:
                missing.append("writer.md(内容过短)")
        if missing:
            raise RuntimeError(f"质量门禁未通过，缺失产物: {', '.join(missing)}")

    async def _package(
        self, run_dir: Path, topic: str, brief_excerpt: str, platform_id: str, result: PhaseResult,
        mode: str = "text", phase_order: list[dict] | None = None, skip_gate: bool = False,
    ) -> str:
        # 终检闸门：产物不全则打包失败（原 quality_gate 职责，不再单独排队）；
        # 失败兜底路径（skip_gate）仍产出 final.md
        if not skip_gate:
            await self._quality_gate(run_dir, phase_order)
        writer_raw = await self.files.safe_read(run_dir / "writer.md")
        body = writer_raw.decode("utf-8", "replace") if writer_raw else ""
        if not body.strip():
            body = "# 无正文草稿\n\nwriter.md 缺失，请检查前序阶段。\n"
        visual = ""
        raw_visual = await self.files.safe_read(run_dir / "visual_director.md")
        if raw_visual:
            visual = raw_visual.decode("utf-8", "replace")
        distribution = "\n\n".join(
            [await self._read_or(run_dir, path) for path, _ in _PACKAGE_SOURCES]
        )
        title = self._pick_title(topic, body)

        final_text = ""
        if self.ai is not None and self.ai.llm_available:
            messages = build_synthesis_messages(
                topic=topic, title=title, brief_excerpt=brief_excerpt,
                platform_id=platform_id, body=body, visual=visual, distribution=distribution,
                mode=mode, templates=self._prompt_templates,
            )
            try:
                async with asyncio.timeout(120):
                    candidate = (await self.ai.chat_messages(messages)).strip()
                if len(candidate) > 100:
                    final_text = candidate
            except Exception:  # noqa: BLE001 — fall back to concatenation
                logger.exception("package synthesis failed, falling back")
        if not final_text:
            final_text = await self._assemble(
                title, topic, body, visual, distribution, run_dir, mode
            )

        await self.files.atomic_write(run_dir / "final.md", final_text)
        summary = self._summary(run_dir)
        await self.files.atomic_write(run_dir / "summary.md", summary)
        result.output_file = "final.md"
        return final_text

    async def _content_pipeline(self, run_dir: Path, result: PhaseResult) -> None:
        """Bridge phase: kick the execution-domain pipeline (to the review gate)."""
        from backend.factory.registry import ServiceRegistry  # deferred import

        service = ServiceRegistry.get().pipeline
        steps_result = await service.run_chain(limit=10)
        lines = ["# 内容流水线\n"]
        for step, data in steps_result.items():
            summary = data.get("summary") or {}
            lines.append(f"## {step}\n\n- 状态: {data.get('status')}\n- {summary}\n")
        await self.files.atomic_write(run_dir / "pipeline.md", "\n".join(lines))
        result.output_file = "pipeline.md"

    # ---------- helpers ----------

    async def _read_or(self, run_dir: Path, name: str) -> str:
        raw = await self.files.safe_read(run_dir / name)
        return raw.decode("utf-8", "replace") if raw else ""

    async def _prior_excerpt(self, run_dir: Path) -> str:
        for name in ("director.md", "brief.md"):
            raw = await self.files.safe_read(run_dir / name)
            if raw:
                return raw.decode("utf-8", "replace")
        return ""

    @staticmethod
    def _pick_title(topic: str, body: str) -> str:
        for line in topic.splitlines():
            line = line.strip().lstrip("#").strip()
            if len(line) > 3:
                return line[:60]
        for line in body.splitlines():
            line = line.strip().lstrip("#").strip()
            if len(line) > 3:
                return line[:60]
        return "未命名作品"

    async def _assemble(
        self, title: str, topic: str, body: str, visual: str, distribution: str, run_dir: Path,
        mode: str = "text",
    ) -> str:
        # 创作模式决定 final.md 章节顺序（AXIOM §35/§38）：
        # 视觉模式 → 视觉方案/配图提前；视频模式 → 视频相关(视觉分镜)提前；
        # 图文模式 → 正文优先。
        visual_first = mode in ("visual", "video")
        sections: list[tuple[str, str]] = []
        if visual_first and visual.strip():
            sections.append(("视觉方案", visual))
        sections.append(("正文", body))
        if not visual_first and visual.strip():
            sections.append(("视觉方案", visual))
        image_names = await self._image_manifest(run_dir)
        if image_names:
            imgs = [f"- ![{name}](images/{name})" for name in image_names]
            if visual_first:
                sections.insert(1, ("配图", "\n".join(imgs)))
            else:
                sections.append(("配图", "\n".join(imgs)))
        if distribution.strip():
            sections.append(("分发策略", distribution))

        lines = [f"# {title}", "", f"> 主题: {topic}", ""]
        for name, content in sections:
            lines += [f"## {name}", "", content, ""]
        return "\n".join(lines).rstrip() + "\n"

    async def _image_manifest(self, run_dir: Path) -> list[str]:
        images = run_dir / "images"
        try:
            names = await asyncio.to_thread(list, images.iterdir())
            return sorted(
                p.name for p in names if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp")
            )
        except OSError:
            return []

    def _summary(self, run_dir: Path) -> str:
        produced = sorted(p.name for p in run_dir.iterdir() if p.is_file() and p.suffix == ".md")
        return "# 产出清单\n\n" + "\n".join(f"- {name}" for name in produced) + "\n"

    async def _save_phase(self, run_id: UUID, key: str, result: PhaseResult) -> None:
        try:
            async with session_factory() as session:
                row = await session.execute(
                    select(PhaseRun).where(PhaseRun.run_id == run_id, PhaseRun.phase_key == key)
                )
                pr = row.scalar_one_or_none()
                if pr is None:
                    pr = PhaseRun(run_id=run_id, phase_key=key)
                pr.status = result.status
                pr.duration_ms = result.duration_ms
                pr.error = result.error or None
                pr.output_json = {"output_file": result.output_file} if result.output_file else None
                await session.merge(pr)
                await session.commit()
        except Exception:  # noqa: BLE001 — DB persistence must never kill the run
            logger.exception("failed to persist phase %s for run %s", key, run_id)

    def _emit(self, event: str, run_id: UUID | None, **payload) -> None:
        data = {"type": event, **payload}
        if run_id is not None:
            self.hub.publish(f"studio:{run_id}", data)
        self.hub.publish("studio", data)

    def _run_dir(self, run: WorkflowRun) -> Path:
        return self.files.run_dir(run)
