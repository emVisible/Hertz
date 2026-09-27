"""Monoline 冷启动验收（Phase 4.3 地基回哺：monoline warmup 思想）。

2 拍中文 fixture 走 service 全链：大纲→TTS（真 Kokoro）→组装→字体→合成→门禁→
渲染→交付。render 需 Chrome（data/models/browser），缺失时在 gate 后止步并
warning（退出 0，前序链已验收）；compose/index.html 未产出则退出 1。

用法：uv run python scripts/monoline_warmup.py [--keep]
"""

import asyncio
import sys
from uuid import UUID

FIXTURE = "第一拍：冷启动验收，检查切分与合成。第二拍：确认旁白与字幕时序正确。"


async def main(keep: bool = False) -> int:
    from backend.factory.registry import ServiceRegistry
    from backend.infrastructure.events import EventHub
    from backend.infrastructure.storage import file_store
    from backend.monoline.hf import chrome_available
    from backend.monoline.service import MonolineService
    from backend.monoline.store import MonolineStore

    ServiceRegistry.get()  # 单例预热（service 直连 file_store/hub，不依赖 initialize）
    svc = MonolineService(files=file_store, hub=EventHub(), store=MonolineStore())
    created = await svc.create_job(FIXTURE, config={"brand": "warmup"})
    jid = UUID(created["id"])
    print(f"job {jid.hex[:8]} …", flush=True)
    await svc.run(jid)
    while svc.running:  # noqa: ASYNC110 — 轮询单航班状态，Event 需 service 侧改造才有
        await asyncio.sleep(1.0)
    job = await svc.get_job(jid)
    assert job is not None
    stages = {s["key"]: s for s in job["stages"]}
    order = ["script", "tts", "assemble", "plan", "fonts", "compose", "gate",
             "render", "deliver"]
    for key in order:
        st = (stages.get(key) or {}).get("status", "-")
        err = (stages.get(key) or {}).get("error") or ""
        print(f"  {key:9s} {st} {err[:100]}")
    if not chrome_available():
        print("WARN: 无可用 Chrome（data/models/browser 与系统 Chrome 均缺失），"
              "render/deliver 未验收", flush=True)
        ok = all((stages.get(k) or {}).get("status") == "succeeded"
                 for k in ("script", "tts", "assemble", "plan", "fonts", "compose"))
        print("warmup:", "PASS（至 compose）" if ok else "FAIL")
        if not keep:
            await svc.delete_job(jid)
        return 0 if ok else 1
    ok = job["status"] == "succeeded"
    print("warmup:", "PASS（九阶段全链）" if ok else f"FAIL: {job.get('error')}")
    if not keep:
        await svc.delete_job(jid)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main("--keep" in sys.argv[1:])))
