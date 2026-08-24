"""生产者共享基建（v0.22.x B 系解体）：错误类型 / 协作式取消 / ffmpeg 子进程。

自 media.py 迁出的最小公共集——story/intro/compose 等子模块经此复用，
避免回引 media 造成环。取消令牌登记仍在 media.produce_item 入口。
"""

import asyncio
import logging

from backend.pipeline.cancel import ItemCancelledError, active_item, is_cancelled

logger = logging.getLogger(__name__)


class ProducerError(RuntimeError):
    """Raised when a producer cannot complete its artifact."""




def _raise_if_cancelled() -> None:
    """协作式取消检查点（wave11）：命中即抛 ItemCancelledError 中止产线。

    读取 ContextVar 活动条目（produce_item 入口登记）——检查点无需
    透传 item_id 参数；无活动条目（测试直接调用/其他产线）时为空操作。
    ItemCancelledError 继承 Exception——但 produce 内所有 except Exception
    的降级分支都只会吞 ProducerError 等业务异常，检查点放在阶段之间，
    不会被误吞（各降级 try 块内部不设检查点）。
    """
    current = active_item()
    if current is not None and is_cancelled(current):
        raise ItemCancelledError(f"produce cancelled for item {current}")




async def _run_cmd(cmd: list[str], *, timeout_s: int = 300) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        # 协作式取消（wave11）：0.25s 粒度轮询取消标志——命中即 terminate
        # （合成/转码是耗时大头，必须真杀进程才能省资源）
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        while True:
            current = active_item()
            if current is not None and is_cancelled(current):
                if proc.returncode is None:
                    proc.terminate()
                out, err = await proc.communicate()
                raise ItemCancelledError(f"command cancelled: {cmd[0]}")
            remaining = deadline - loop.time()
            if remaining <= 0:
                proc.kill()
                raise ProducerError(f"command timed out after {timeout_s}s: {cmd[0]}") from None
            try:
                await asyncio.wait_for(proc.wait(), timeout=min(0.25, remaining))
                break
            except TimeoutError:  # asyncio.TimeoutError 是内建 TimeoutError 别名（ruff UP041）
                continue
        out, err = await proc.communicate()
    except TimeoutError:
        proc.kill()
        raise ProducerError(f"command timed out after {timeout_s}s: {cmd[0]}") from None
    if proc.returncode != 0:
        tail = err.decode(errors="replace")[-500:]
        raise ProducerError(f"{cmd[0]} failed ({proc.returncode}): {tail}")
    return out


