"""封面生成域（v0.22.x B 系解体，自 media.py 迁出）。

职责单一：智能帧选择（signalstats 亮度评分）/ 随机抽帧 / 封面裁切。
不含：视频合成（compose_video 在 media.py）、字幕烧录。
"""

import asyncio
import random
import re
from pathlib import Path

from backend.library.thumbnails import find_ffmpeg
from backend.pipeline.producers.common import ProducerError, _run_cmd
from backend.pipeline.producers.probe import probe_duration, probe_video_duration


async def _frame_interest(ffmpeg: str, probe_path: Path) -> float:
    """帧兴趣分（v0.3.0，参考原项目 cover.py）：signalstats 对比度（YSTD）
    为主分，暗/过曝（YAVG 越界）惩罚。返回 -1 = 不可评分。"""
    proc = await asyncio.create_subprocess_exec(
        str(ffmpeg), "-i", str(probe_path), "-vf",
        "signalstats,metadata=print:file=-", "-frames:v", "1", "-f", "null", "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=30)
    except TimeoutError:
        proc.kill()
        return -1.0
    ystd = yavg = None
    for line in out.decode(errors="replace").splitlines():
        m = re.search(r"YSTD=([\d.]+)", line)
        if m:
            ystd = float(m.group(1))
        m = re.search(r"YAVG=([\d.]+)", line)
        if m:
            yavg = float(m.group(1))
    if ystd is None:
        return -1.0
    score = ystd
    if yavg is not None:
        score -= max(0.0, 20.0 - yavg) * 0.2  # 暗画面惩罚
        score -= max(0.0, yavg - 235.0) * 0.2  # 过曝惩罚
    return score

async def generate_cover(raw: Path, out: Path) -> dict:
    """封面抽帧（v0.3.0，参考原项目 cover.py 兴趣评分）：
    5 位置采样（短片 3 个）→ 对比度/亮度评分取最高 → 16:9 裁切；
    全失败回退首帧，避免封面缺失。"""
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    out.parent.mkdir(parents=True, exist_ok=True)
    duration = await probe_duration(raw)
    positions = [0.18, 0.32, 0.48, 0.62, 0.78] if duration >= 4 else [0.2, 0.5, 0.8]
    best_score = -1.0
    best_pct = 0.0
    probe_dir = out.parent / "cover-probes"
    await asyncio.to_thread(probe_dir.mkdir, exist_ok=True)
    for pct in positions:
        probe = probe_dir / f"p{int(pct * 100)}.jpg"
        try:
            await _run_cmd([
                str(ffmpeg), "-y", "-ss", str(max(duration * pct, 0.0)),
                "-i", str(raw), "-frames:v", "1",
                "-vf", "scale=160:90,format=yuv420p", str(probe),
            ])
        except Exception:  # noqa: BLE001 — 单位置失败跳过
            continue
        score = await _frame_interest(str(ffmpeg), probe)
        if score > best_score:
            best_score, best_pct = score, pct
        try:
            probe.unlink()
        except OSError:
            pass
    if best_score < 0:
        best_pct = 0.0  # 全部失败 → 首帧兜底
    await _run_cmd([
        str(ffmpeg), "-y", "-ss", str(max(duration * best_pct, 0.0)),
        "-i", str(raw), "-frames:v", "1",
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        str(out),
    ])
    return {"path": str(out)}

async def extract_random_cover(
    video_path: Path | str, out_path: Path,
) -> Path:
    """随机抽帧封面（v0.11.5）：避开首尾（黑场/片尾），5%-95% 均匀随机
    取一帧 → 1280x720 裁切。抽帧失败抛 ProducerError（调用方转 HTTP 语义）。

    ⚠️ 时长取**视频流**而不是容器（2026-10-19 黑屏事故同族）：容器时长取最长那条
    流（通常是音频），素材里「音频比画面长 8 秒」时，按容器算出来的取帧点会有约
    35% 的概率落在画面结束之后 —— seek 越过末帧，抽出来的封面就是一张黑图，
    而文件确实存在、体积正常，没有任何报错。
    """

    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")
    duration = await probe_video_duration(video_path)
    pos = max(0.0, min(duration * (0.05 + 0.9 * random.random()), max(duration - 0.1, 0.0)))
    await _run_cmd([
        str(ffmpeg), "-y", "-ss", f"{pos:.3f}",
        "-i", str(video_path), "-frames:v", "1",
        "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720",
        str(out_path),
    ])
    return out_path
