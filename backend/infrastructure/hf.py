"""HuggingFace 模型文件的下载底座（v0.32 S4）——本地引擎共用的公共语义。

为什么自己下，而不用 `faster_whisper.download_model()` / `huggingface_hub`：
端点候选序必须在**每次尝试**时生效，而 `huggingface_hub.constants.ENDPOINT`
是导入期从 `HF_ENDPOINT` 算出来的（1.27 实测），进程里改环境变量无效——要么
私改库常量（脆），要么自己发请求。自建这条路径顺便换到两件事：

- 流式写盘 + `.part` 原子改名：141MB 的 model.bin 不再整份进内存，
  中途断网也不会留下半截文件被就绪探测当成「已下好」。
- 失败原因按端点汇总返回，调用方（各引擎）只管告警文案。

依赖方向：infra 不认识 pipeline；pipeline 传入自己的 repo/文件清单/端点序列。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from pathlib import Path

logger = logging.getLogger(__name__)

OFFICIAL_ENDPOINT = "https://huggingface.co"
MIRROR_ENDPOINT = "https://hf-mirror.com"

_CHUNK = 1 << 20


def candidate_endpoints(configured: str | None = None) -> list[str]:
    """去重后的候选端点序列：用户配置优先 → 官方 → 镜像；空/空白配置项自动跳过。"""
    cfg = (configured or "").strip().rstrip("/")
    out: list[str] = []
    for ep in (cfg, OFFICIAL_ENDPOINT, MIRROR_ENDPOINT):
        if ep and ep not in out:
            out.append(ep)
    return out


def endpoint_candidates() -> list[str]:
    """当前配置下的候选序（读设置的唯一入口，两个本地引擎共用）。

    「用哪个端点」是网络事实不是引擎事实，所以只有一项设置（`pipeline_hf_endpoint`）
    和一个读它的地方——否则用户切镜像要记得切两处，漏一处就是某能力静默不可用。
    """
    from backend.config import settings

    return candidate_endpoints(
        str(getattr(settings, "pipeline_hf_endpoint", "") or "")
    )


async def _stream_to(client, url: str, out: Path, *, required: bool) -> str:
    """单文件流式下载。返回 "ok" / "skip"（可选文件 404）；其余异常向上冒泡换端点。"""
    if await asyncio.to_thread(out.exists):  # 幂等：重下只补缺
        return "ok"
    tmp = out.with_name(f"{out.name}.part")
    try:
        async with client.stream("GET", url) as resp:
            if resp.status_code == 404 and not required:
                return "skip"
            resp.raise_for_status()

            with tmp.open("wb") as fh:
                # 逐块流式写，且写盘放线程里：141MB 期间不冻结事件循环（后端同时供着 UI）
                async for chunk in resp.aiter_bytes(_CHUNK):
                    await asyncio.to_thread(fh.write, chunk)
        await asyncio.to_thread(tmp.replace, out)
        return "ok"
    except BaseException:
        # 半截文件绝不能留下——就绪探测只认文件名，`.part` 留着就是下次重下的干扰
        if await asyncio.to_thread(tmp.exists):
            await asyncio.to_thread(tmp.unlink)
        raise


_download_lock = asyncio.Lock()


def _reason(exc: BaseException) -> str:
    """异常 → 用户能行动的短句。

    httpx 的 `ConnectError` 消息经常是**空的**（实测：本机代理 127.0.0.1:7897 一关，
    两个端点各报 `ConnectError: `，告警里就只剩一个冒号）。下载失败时用户看到的
    最后一条信息不该是这个，所以空消息兜底带上代理状态——「切镜像」和「你的代理
    挂了」是两个完全不同的修复动作。
    """
    name = type(exc).__name__
    msg = str(exc).strip()
    if not msg:
        cause = exc.__cause__
        if cause is not None:
            msg = str(cause).strip() or type(cause).__name__
    if name in {"ConnectError", "ConnectTimeout", "ProxyError"}:
        try:
            from backend.infrastructure.net import system_proxies

            prox = system_proxies()
        except Exception:  # noqa: BLE001 — 探测失败不该盖住真实原因
            prox = {}
        detail = "、".join(f"{k}→{v}" for k, v in sorted(prox.items())) or "直连（未设代理）"
        msg = f"{msg}；代理：{detail}" if msg else f"连不上，代理：{detail}"
    return f"{name}: {msg}" if msg else name


async def download_files(
    repo: str,
    files: Sequence[tuple[str, bool]],
    dest: Path,
    endpoints: Sequence[str],
) -> tuple[bool, list[str]]:
    """按端点候选序下载 `files`（(文件名, 是否必需)）到 `dest`。

    返回 (是否齐全, 各端点失败原因)。必需文件 404/超时/连接失败都算该端点失败，
    换下一个端点重来；可选文件 404 静默跳过（不同 repo 的文件集本就不同）。

    全局串行：两个并发下载会写同一个 `<file>.part`（实测：设置页点了下载、
    产线紧接着转写 → 第二条 `ensure_model` 与第一条同时开流，交错写出的
    model.bin 直接损坏）。下载本就是一次性的分钟级动作，排队比省事更对；
    排在后面的那次会因为逐文件 `exists()` 幂等检查而几乎立刻返回。
    """
    async with _download_lock:
        return await _download_files(repo, files, dest, endpoints)


async def _download_files(
    repo: str,
    files: Sequence[tuple[str, bool]],
    dest: Path,
    endpoints: Sequence[str],
) -> tuple[bool, list[str]]:
    import httpx

    try:
        await asyncio.to_thread(dest.mkdir, parents=True, exist_ok=True)
    except OSError as exc:
        return False, [f"mkdir {dest}: {exc}"]

    errors: list[str] = []
    timeout = httpx.Timeout(30.0, read=600.0)  # 大模型文件读取远超握手
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for endpoint in endpoints:
            base = f"{endpoint.rstrip('/')}/{repo}/resolve/main"
            try:
                for fname, required in files:
                    state = await _stream_to(
                        client, f"{base}/{fname}", dest / fname, required=required
                    )
                    logger.debug("model file %s: %s (%s)", fname, state, endpoint)
                missing = [f for f, req in files if req and not (dest / f).exists()]
                if missing:
                    raise RuntimeError(f"incomplete: {missing}")
                return True, []
            except Exception as exc:  # noqa: BLE001 — 换下一端点
                errors.append(f"{endpoint}: {_reason(exc)}")
                logger.warning("model download failed via %s: %s", endpoint, _reason(exc))
    return False, errors
