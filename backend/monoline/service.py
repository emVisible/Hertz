"""MonolineService — 融合域执行入口（仿 StudioService 单航班）。

本期（Phase 1.3）运行线只到文本路径：建作业 → 大纲（切分+规则分镜，无音频）→
分镜落盘（source=rules/manual）。TTS/组装/字体/合成/门禁/渲染/交付在 1.4/Phase 3
接入 runner 全九阶段（D-022 统一走 TaskRouter，D-024 Kokoro 分支）。
长任务经后台 asyncio.Task 单航班 + EventHub（`monoline` / `monoline:{job_id}`）广播。
"""

from __future__ import annotations

import asyncio
import logging
import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from backend.infrastructure.events import EventHub
from backend.infrastructure.storage import FileStore
from backend.monoline import outline as outline_mod
from backend.monoline.runner import JobCancelledError
from backend.monoline.store import MonolineStore

logger = logging.getLogger(__name__)


def _slug(text: str, n: int = 24) -> str:
    keep = [c if c.isalnum() else "-" for c in (text or "").lower()]
    s = "".join(keep).strip("-")
    s = "-".join(filter(None, s.split("-")))
    return s[:n] or "untitled"


class MonolineService:
    def __init__(self, files: FileStore, hub: EventHub,
                 store: MonolineStore | None = None, tts_provider=None,
                 hf=None) -> None:
        self.files = files
        self.hub = hub
        self.store = store or MonolineStore()
        self._tts_provider = tts_provider  # None → KokoroProvider（本地）；测试可注入 stub
        self._hf = hf  # None → 真实 HF（HyperFrames CLI）；测试可注入 FakeHF
        self._task: asyncio.Task | None = None
        self._current_id: UUID | None = None
        self._cancel: dict[str, asyncio.Event] = {}

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def ws_root(self, job_id: UUID) -> Path:
        return self.files.output_root() / "monoline" / job_id.hex

    def brand_dir(self) -> Path:
        d = self.files.data_dir / "monoline" / "brand"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _emit(self, job_id: UUID | None, event: str, **payload) -> None:
        data = {"type": event, **payload}
        if job_id is not None:
            self.hub.publish(f"monoline:{job_id.hex}", data)
        self.hub.publish("monoline", data)

    # ---------- jobs ----------

    async def create_job(self, script: str, config: dict | None = None,
                         canvas: dict | None = None) -> dict:
        config = dict(config or {})
        # 品牌缺省：未显式传的 brand/theme/accent 走用户品牌（上游 apply_to_config 语义）
        brand = await self.store.get_brand()
        config.setdefault("brand", brand.get("label") or "Monoline")
        if not config.get("theme") and brand.get("theme"):
            config["theme"] = brand["theme"]
        if not config.get("accent") and brand.get("accent"):
            config["accent"] = brand["accent"]
        job_id = await self.store.create_job(
            script_text=script, config=config, canvas=canvas or {},
        )
        await self.freeze_brand_logo(job_id)
        await self.apply_brand_bgm(job_id)
        return {"id": str(job_id)}

    async def freeze_brand_logo(self, job_id: UUID) -> str:
        """品牌 logo 冻入作业 composition/assets（上游 freeze_logo_into 语义）。"""
        import hashlib

        from .workspace import Workspace

        brand = await self.store.get_brand()
        name = brand.get("logo_name")
        if not name:
            return ""
        src = self.brand_dir() / name
        if not src.is_file():
            return ""
        ws = Workspace(self.ws_root(job_id)).ensure()
        data = src.read_bytes()
        rel = f"assets/{hashlib.sha1(data).hexdigest()[:16]}{src.suffix.lower()}"
        (ws.composition / rel).write_bytes(data)
        return rel

    async def apply_brand_bgm(self, job_id: UUID) -> str:
        """品牌默认 BGM（brand_dir/bgm.* 约定，无迁移）：拷入作业并落 config.bgm。

        显式 config.bgm 优先（用户已传则不动）；无品牌曲则返回空。
        """
        import shutil

        from .workspace import Workspace

        job = await self.store.get_job(job_id)
        if job is None:
            return ""
        config = dict(job.get("config") or {})
        if config.get("bgm"):
            return ""
        candidates = sorted(self.brand_dir().glob("bgm.*"))
        src = next((p for p in candidates if p.is_file()), None)
        if src is None:
            return ""
        ws = Workspace(self.ws_root(job_id)).ensure()
        for old in ws.comp_audio.glob("bgm.*"):
            old.unlink(missing_ok=True)
        shutil.copy(src, ws.comp_audio / f"bgm{src.suffix.lower()}")
        config["bgm"] = {"src": f"audio/bgm{src.suffix.lower()}",
                         "volume": 0.22, "duck": True}
        await self.store.update_job(job_id, config=config)
        return config["bgm"]["src"]

    async def get_job(self, job_id: UUID) -> dict | None:
        job = await self.store.get_job(job_id)
        if job is None:
            return None
        job["stages"] = await self.store.list_stages(job_id)
        return job

    async def history(self, limit: int = 50) -> list[dict]:
        return await self.store.list_jobs(limit=limit)

    async def delete_job(self, job_id: UUID) -> bool:
        ok = await self.store.delete_job(job_id)
        root = self.ws_root(job_id)
        if root.exists():
            await asyncio.to_thread(shutil.rmtree, root, ignore_errors=True)
        return ok

    # ---------- outline ----------

    async def build_outline(self, job_id: UUID) -> dict:
        view = await outline_mod.build(self.store, self.ws_root(job_id), job_id)
        entries = view.get("entries") or []
        if entries:
            first = str(entries[0].get("text") or "")
            await self.store.update_job(job_id, title=first[:48], slug=_slug(first))
        self._emit(job_id, "outline", beats=view.get("beats"))
        return view

    async def get_outline(self, job_id: UUID) -> dict:
        return await outline_mod.current(self.store, job_id)

    async def apply_outline(self, job_id: UUID, edits: list[dict]) -> dict:
        view = await outline_mod.apply(self.store, self.ws_root(job_id), job_id, edits)
        self._emit(job_id, "outline", beats=view.get("beats"), manual=True)
        return view

    # ---------- run (文本路径：script + plan；音频/渲染见模块 docstring) ----------

    async def run(self, job_id: UUID, *, force: bool = False) -> dict:
        if self.running:
            raise RuntimeError("monoline 有作业正在运行（单航班），请等待或取消后再试")
        job = await self.store.get_job(job_id)
        if job is None:
            raise KeyError(str(job_id))
        ev = asyncio.Event()
        self._cancel[job_id.hex] = ev
        self._current_id = job_id
        self._task = asyncio.create_task(self._execute(job_id, ev, force=force))
        return {"id": str(job_id), "status": "queued"}

    def cancel(self, job_id: UUID) -> bool:
        ev = self._cancel.get(job_id.hex)
        if ev is not None and not ev.is_set():
            ev.set()
            return True
        return False

    async def _tts(self):
        if self._tts_provider is not None:
            return self._tts_provider
        from backend.ai.providers.kokoro import KokoroProvider

        return KokoroProvider()

    async def tts_provider(self):
        """TTS provider 公开访问点（逐拍端点与 _execute 共用，测试可注入 stub）。"""
        return await self._tts()

    def _default_hf(self):
        """真实 HF（带 Node 22 解析）；解析失败返回无 node 绑定的 HF（报错可执行）。"""
        if self._hf is not None:
            return self._hf
        from backend.monoline.hf import HF, resolve_node_bin

        try:
            return HF(node_bin=resolve_node_bin())
        except Exception:  # noqa: BLE001 — gate/render 阶段报错会写明缺 node
            return HF()

    def _registry_ai(self):
        """TaskRouter（LLM 升格用；factory 循环引用故函数内导入，缺失回 None）。"""
        try:
            from backend.factory.registry import ServiceRegistry

            return ServiceRegistry.get().ai
        except Exception:  # noqa: BLE001 — 无 AI 时走纯规则，不阻塞
            return None

    async def _main_model(self) -> str:
        """suggest 缓存键用模型名：main 角色解析失败回 default。"""
        try:
            from backend.ai.registry import ProviderRegistry

            resolved = await ProviderRegistry().resolve_role("main")
            return (resolved or {}).get("model_key") or "default"
        except Exception:  # noqa: BLE001
            return "default"

    async def llm_target(self) -> tuple:
        """LLM 升格/建议的目标（ai, model）：任一缺失调用方回退规则。"""
        return self._registry_ai(), await self._main_model()

    async def _execute(self, job_id: UUID, cancel: asyncio.Event, *, force: bool) -> None:
        from backend.monoline import runner as _runner

        await self.store.update_job(job_id, status="running",
                                    started_at=datetime.now(UTC), error=None)
        self._emit(job_id, "run_start")

        async def _emit(stage: str, data: dict) -> None:
            payload = {"stage": stage, **{k: v for k, v in data.items() if k != "stage"}}
            self._emit(job_id, "stage", **payload)

        try:
            if cancel.is_set():
                raise asyncio.CancelledError()
            job = await self.store.get_job(job_id)
            config = (job or {}).get("config") or {}
            # script + plan 经 run_text：hash 未变整段 skipped（手工大纲保留），
            # llm_plan 显式开启才走规则 + LLM 升格（Hertz 缺省 False 防意外账单，
            # 上游缺省 True；manual 恒保留，keep_richer 防降级）
            text_out = await _runner.run_text(
                self.store, self.ws_root(job_id), job_id, force=force,
                llm_upgrade=bool(config.get("llm_plan", False)),
                ai=self._registry_ai(), model=await self._main_model(),
                batch_beats=int(config.get("llm_batch_beats") or 3),
                batch_chars=int(config.get("llm_batch_chars") or 900),
                budget_seconds=float(config.get("llm_plan_seconds") or 150),
                cancel=cancel, emit=_emit)
            beats = text_out.get("beats", 0)
            job = await self.store.get_job(job_id)
            config = (job or {}).get("config") or {}
            voice = config.get("voice") or "zf_xiaoxiao"
            lang = config.get("lang") or "zh"
            speed = float(config.get("speed") or 1.0)
            emit = _emit
            # 全九阶段（CLI-first；render 需 Chrome，缺失时该阶段失败但前序产物保留）
            await _runner.run_tts(self.store, self.ws_root(job_id), job_id,
                                  voice=voice, lang=lang, speed=speed,
                                  tts_provider=await self.tts_provider(),
                                  cancel=cancel, emit=emit)
            await _runner.run_assemble(self.store, self.ws_root(job_id), job_id,
                                       cancel=cancel, emit=emit)
            await _runner.run_fonts(self.store, self.ws_root(job_id), job_id,
                                    cancel=cancel, emit=emit)
            await _runner.run_compose(self.store, self.ws_root(job_id), job_id,
                                      cancel=cancel, emit=emit)
            await _runner.run_gate(self.store, self.ws_root(job_id), job_id,
                                   cancel=cancel, emit=emit, hf=self._default_hf())
            await _runner.run_render(self.store, self.ws_root(job_id), job_id,
                                     cancel=cancel, emit=emit, hf=self._default_hf())
            fin = await _runner.run_deliver(self.store, self.ws_root(job_id), job_id,
                                            cancel=cancel, emit=emit)
            await self.store.add_event(job_id, "run", level="info",
                                       message=f"完成：{beats} 拍，"
                                               f"成片 {fin.get('duration', 0):.1f}s")
            await self.store.update_job(job_id, status="succeeded",
                                        finished_at=datetime.now(UTC), error=None)
            self._emit(job_id, "run_done", status="succeeded", beats=beats)
        except JobCancelledError:
            await self.store.update_job(job_id, status="cancelled",
                                        finished_at=datetime.now(UTC))
            await self.store.add_event(job_id, "run", level="warn", message="cancelled by user")
            self._emit(job_id, "run_done", status="cancelled")
        except Exception as exc:  # noqa: BLE001 — 落库 + 广播，不杀进程
            logger.exception("monoline job %s failed", job_id.hex)
            await self.store.update_job(job_id, status="failed",
                                        finished_at=datetime.now(UTC), error=str(exc)[:500])
            await self.store.add_event(job_id, "run", level="error", message=str(exc)[:500])
            self._emit(job_id, "run_done", status="failed", error=str(exc)[:500])
        finally:
            self._cancel.pop(job_id.hex, None)
            if self._current_id == job_id:
                self._current_id = None

    # ---------- reconcile（启动时：中断作业回 queued + 事件，不自动开跑） ----------

    async def reconcile(self) -> list[str]:
        stuck = await self.store.list_by_status(("running", "queued"))
        for j in stuck:
            jid = UUID(j["id"])
            await self.store.update_job(jid, status="queued")
            await self.store.add_event(jid, "reconcile", level="warn",
                                       message="服务重启，中断的作业已回队列（需手动重跑）")
        return [j["id"] for j in stuck]
