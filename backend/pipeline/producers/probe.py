"""媒体探测域（v0.22.x B1 归一，D-187 耦合热点清偿）：ffprobe 封装单点。

历史状态：时长探测三处同构（media.probe_duration / phash._probe_duration /
metadata 内嵌）、流参数两种形态（probe_has_audio / _probe_video_params）——
统一收敛于此，phash/metadata 改引本模块。

降级契约：ffprobe 缺失或解析失败时按调用方语义返回安全默认
（时长 0.0 / 含音轨 True / 流参数 None），绝不抛出阻塞产线。
"""

import asyncio
import json
from pathlib import Path

from backend.library.thumbnails import find_ffprobe


async def _ffprobe_json(args: list[str], *, timeout_s: float = 30) -> dict:
    """执行 ffprobe 并解析 JSON 输出；失败返回 {}。"""
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return {}
    proc = await asyncio.create_subprocess_exec(
        ffprobe, *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except TimeoutError:
        proc.kill()
        return {}
    try:
        return json.loads(out.decode() or "{}")
    except ValueError:
        return {}


async def probe_duration(path: Path | str) -> float:
    """容器总时长（秒）；不可得返回 0.0。"""
    data = await _ffprobe_json([
        "-v", "quiet", "-print_format", "json", "-show_format", str(path),
    ])
    try:
        return float(data.get("format", {}).get("duration") or 0.0)
    except (TypeError, ValueError):
        return 0.0


async def probe_audio_duration(path: Path | str) -> float:
    """首音轨时长（秒；v0.8.9 原声字幕时间轴基准）。无音轨回退容器时长。"""
    data = await _ffprobe_json([
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=duration", "-of", "json", str(path),
    ])
    streams = data.get("streams") or []
    if streams and streams[0].get("duration"):
        try:
            return float(streams[0]["duration"])
        except (TypeError, ValueError):
            pass
    return await probe_duration(path)


async def probe_video_duration(path: Path | str) -> float:
    """主视频流时长（秒）；不可得回退容器时长。

    **为什么必须有它（而不是直接用容器时长）**：容器时长取**最长那条流**，通常是音轨。
    素材里出现「音频比画面长」时（实测有 reddit 片段音频长出 8s），容器时长会大于视频流
    真实时长——而合成链的 xfade offset 必须按**视频**累加，否则 offset 会越过已拼好的
    画面长度，xfade 停止延长视频而音频照常走完，成片后半段就成了一整段无帧的黑屏
    （2026-10-19 的合集黑屏事故，见 assemble._build_xfade_chain 的注释）。
    """
    data = await _ffprobe_json([
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=duration", "-of", "json", str(path),
    ])
    streams = data.get("streams") or []
    if streams and streams[0].get("duration"):
        try:
            return float(streams[0]["duration"])
        except (TypeError, ValueError):
            pass
    return await probe_duration(path)


async def probe_has_audio(path: Path | str) -> bool:
    """是否含音轨——ASR 前提；探测不可用时默认 True（宁做不做哑字幕）。

    csv 输出非 JSON——独立子进程调用（不走 _ffprobe_json）。
    """
    ffprobe = find_ffprobe()
    if ffprobe is None:
        return True
    proc = await asyncio.create_subprocess_exec(
        ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
        "stream=index", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return bool((out.decode(errors="replace") or "").strip())


async def video_stream_params(
    path: Path | str,
) -> tuple[int, int, float, bool] | None:
    """主片视频流 (宽, 高, fps, 是否含音轨)；无法解析返回 None。

    （原 media._probe_video_params——片头 concat 按主片参数编码用）
    """
    data = await _ffprobe_json([
        "-v", "quiet", "-print_format", "json", "-show_streams", str(path),
    ])
    streams = data.get("streams") or []
    v = next((s for s in streams if s.get("codec_type") == "video"), {})
    if not v.get("width"):
        return None
    rate = str(v.get("r_frame_rate") or "30/1")
    num, _, den = rate.partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 30.0
    return (
        int(v["width"]),
        int(v.get("height") or 720),
        fps if fps > 0 else 30.0,
        any(s.get("codec_type") == "audio" for s in streams),
    )
