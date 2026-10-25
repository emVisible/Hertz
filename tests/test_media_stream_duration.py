"""「容器时长 ≠ 流时长」这一族缺陷的判据（2026-10-19 合集黑屏事故同族）。

## 这一族的形状

`ffprobe` 的**容器时长取最长那条流**，通常是音轨。而素材里「音频比画面长」是常态
（本机 `data/media/videos` 扫出一批，差 0.6–4.6 秒；事故那一条差 8 秒）。
于是任何**问容器、拿它当画面长度用**的地方都会算错：

| 位置 | 拿时长做什么 | 问错了会怎样 |
|---|---|---|
| `assemble` 的 offset | xfade 接缝点 | **后半段黑屏**（判据在 test_producer_assemble.py） |
| `cover` 取帧点 | 随机抽帧的位置 | 越过画面末尾 → **黑封面**，文件正常、无报错 |
| `phash` 的 25% seek | 哈希取帧位置 | 越过末帧 → **哈希静默变 None** |
| `compose` 的 target | 字幕右界 / 末尾补齐 | 字幕排进无画面的时段 |

## 判据怎么写才算数

**不测「没抛异常」**——这一族的共同特征就是**不报错**：黑封面文件存在、体积正常、
哈希只是变成 None、字幕只是排到了没画面的时间里。所以每条判据都直接量**用户会
看到的那件事**（封面亮不亮、哈希在不在、成片视频流够不够长）。

## 变异对照（改坏任一条，对应用例必须变红）
- 封面/哈希/合成任一处退回 `probe_duration` → 对应用例红
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.library.thumbnails import find_ffmpeg

ffmpeg = find_ffmpeg()
pytestmark = pytest.mark.ffmpeg

needs_ffmpeg = pytest.mark.skipif(ffmpeg is None, reason="ffmpeg not available")


async def _make_clip(
    path: Path,
    *,
    seconds: float = 2.0,
    audio_seconds: float | None = None,
    color: str = "white",
    size: str = "320x240",
) -> Path:
    """一段**画面亮、音频长**的素材——事故形状的最小复现。"""
    args = [
        str(ffmpeg), "-y", "-v", "error",
        "-f", "lavfi", "-i", f"color=c={color}:size={size}:rate=30:duration={seconds}",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={audio_seconds or seconds}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        str(path),
    ]
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    assert await asyncio.to_thread(path.exists), f"测试素材合成失败：{path.name}"
    return path


async def _mean_luma(path: Path) -> float:
    """整幅的平均亮度（0-255）。黑图≈0，亮图≈255。"""
    proc = await asyncio.create_subprocess_exec(
        str(ffmpeg), "-v", "error", "-i", str(path), "-frames:v", "1",
        "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return sum(out) / max(len(out), 1)


@needs_ffmpeg
async def test_probe_separates_video_and_audio_duration(tmp_path: Path) -> None:
    """先钉住探针本身：视频流与容器（音频）时长确实不同。"""
    from backend.pipeline.producers.probe import (
        probe_audio_duration,
        probe_duration,
        probe_video_duration,
    )

    clip = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio_seconds=10.0)

    v = await probe_video_duration(clip)
    a = await probe_audio_duration(clip)
    c = await probe_duration(clip)

    assert v == pytest.approx(2.0, abs=0.3), f"视频流时长应为 ~2s，实得 {v:.1f}s"
    assert a == pytest.approx(10.0, abs=0.5), f"音频流时长应为 ~10s，实得 {a:.1f}s"
    assert c == pytest.approx(a, abs=0.5), "容器时长应取更长的那条流（音频）"


@needs_ffmpeg
@pytest.mark.parametrize("attempt", range(6))
async def test_cover_is_never_black_when_audio_outlives_video(
    tmp_path: Path, attempt: int,
) -> None:
    """抽帧点必须落在**画面**之内：画面 2s、音频 10s 时有 80% 的旧行为会抽到画面外。

    参数化跑 6 次是因为取帧点是随机的——旧行为下 6 次全对的概率约 0.2⁶，
    也就是这条判据几乎不会「侥幸通过」。
    """
    from backend.pipeline.producers.cover import extract_random_cover

    clip = await _make_clip(tmp_path / f"src{attempt}.mp4", seconds=2.0, audio_seconds=10.0)
    cover = tmp_path / f"cover{attempt}.jpg"

    await extract_random_cover(clip, cover)

    assert await asyncio.to_thread(cover.exists), "封面没产出"
    luma = await _mean_luma(cover)
    assert luma > 40, (
        f"第 {attempt} 次抽出的封面几乎是黑的（平均亮度 {luma:.0f}/255）——"
        "取帧点越过了画面末尾。文件存在、体积正常，所以这个缺陷此前无人报错"
    )


@needs_ffmpeg
async def test_phash_computed_when_audio_outlives_video(tmp_path: Path) -> None:
    """25% 处 seek 必须落在画面之内，否则哈希静默变成 None。"""
    from backend.pipeline.phash import compute_phash

    clip = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio_seconds=10.0)

    assert await compute_phash(str(clip)), (
        "感知哈希算不出来——25% 处 seek 越过了画面末尾（旧行为会静默降级成 no phash）"
    )

@needs_ffmpeg
async def test_compose_targets_the_video_track_not_the_container(tmp_path: Path) -> None:
    """成片不能音画分家：画面 2s、音频 10s 的素材不该被补成 10s 的音轨。

    `compose_video` 的 `target` 同时是字幕右界、图片段长度与末尾 apad/atrim 的
    补齐长度——问错成容器时长时，**被撑长的是音频**（画面不会被拉长），
    于是成片变成「2s 画面 + 8s 音频尾巴」，字幕正好排在没有画面的那 8 秒里。

    所以判据量的是**成片两条流的长度差**，不是视频流本身有多长。
    走**带旁白 + 字幕**这条路径：无旁白时音频轨并不经 `apad=pad_dur={target}`，
    旧行为与新行为都是 2.00/2.00——那个形状测不出差别（实测，别写错判据）。
    """
    from backend.pipeline.producers.compose import compose_video
    from backend.pipeline.producers.probe import (
        probe_audio_duration,
        probe_video_duration,
    )

    raw = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio_seconds=10.0)
    narration = tmp_path / "n.wav"
    proc = await asyncio.create_subprocess_exec(
        str(ffmpeg), "-y", "-v", "error", "-f", "lavfi",
        "-i", "sine=frequency=880:duration=1", str(narration),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    srt = tmp_path / "s.srt"
    srt.write_text("1\n00:00:00,000 --> 00:00:01,500\n测试字幕\n", encoding="utf-8")

    out = tmp_path / "out.mp4"
    await compose_video(raw, narration, srt, out, narr_start=0.0, narr_dur=1.0)

    v, a = await probe_video_duration(out), await probe_audio_duration(out)
    assert abs(v - a) <= 1.0, (
        f"成片音画分家了：视频 {v:.1f}s vs 音频 {a:.1f}s——"
        f"多出来的 {a - v:.1f}s 音频没有画面，字幕就排在那一段里"
    )
