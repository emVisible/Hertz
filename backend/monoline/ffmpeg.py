"""monoline 域的 ffmpeg 子进程助手。

本域刻意零跨域依赖（移植自包含域），pipeline `producers/common._run_cmd`
的取消/超时语义不进来——两域各持各的进程语义，错误信息只有这一处格式。
"""

from __future__ import annotations

import asyncio


async def run_ffmpeg(*cmd: str) -> None:
    """跑 ffmpeg；非零退出抛 RuntimeError（带 stderr 尾 400 字）。"""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg failed ({proc.returncode}): {err.decode(errors='replace')[-400:]}"
        )
