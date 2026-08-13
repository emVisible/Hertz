"""v0.9 对齐原项目 edit.py 的合成核心单测：
音频混流（时间窗口 duck / apad 防塌缩 / amix normalize=0 / anullsrc /
85% 音频时长守卫）与字幕烧录三级降级（libass → PNG overlay → 无字幕）。

所有 ffmpeg/ffprobe 调用以模块级函数 monkeypatch 捕获命令字符串断言，
不依赖本机 ffmpeg 与 libass。
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace


def _write_srt(path: Path) -> None:
    path.write_text(
        "1\n00:00:00,100 --> 00:00:02,000\n他蹲下来了 哭声停了\n\n"
        "2\n00:00:02,500 --> 00:00:04,000\n孩子们用心听着\n\n",
        encoding="utf-8",
    )


async def test_duck_window_filters(monkeypatch, tmp_path):
    """旁白存在：时间窗口 duck（非 sidechain）+ 旁白轨 apad/atrim 防塌缩。"""
    import backend.pipeline.producers.media as m

    raw, narr, srt, out = (
        tmp_path / "raw.mp4", tmp_path / "narr.mp3",
        tmp_path / "subs.srt", tmp_path / "final.mp4",
    )
    raw.write_bytes(b"raw")
    narr.write_bytes(b"narr")
    _write_srt(srt)

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b""

    monkeypatch.setattr(m, "_run_cmd", fake_run)
    async def _pd(p):
        return 5.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad(p):
        return 5.0 if str(p).endswith("raw.mp4") else 5.0

    async def _sfa(f):
        return False

    monkeypatch.setattr(m, "probe_audio_duration", _pad)
    monkeypatch.setattr(m, "subtitles_filter_available", _sfa)
    monkeypatch.setattr(m, "_find_bgm", lambda: None)
    monkeypatch.setattr(m, "srt_to_ass", lambda a, b: None)

    result = await m.compose_video(
        raw, narr, srt, out, narr_start=0.5, narr_dur=4.2
    )

    assert result["quality"]["burn"] == "overlay"
    assert result["quality"]["audio_guard"] == "ok"
    cmd = captured[0]
    fc = " ".join(cmd)
    # 时间窗口 duck：旁白区间压 0.22，非 sidechain
    assert "if(between(t\\,0.500\\,4.700)\\,0.22\\,1.0)" in fc
    assert "sidechaincompress" not in fc
    # 旁白轨 apad/atrim 防 amix 塌缩
    assert "apad=pad_dur=5.0,atrim=duration=5.0" in fc
    # normalize=0 不归一化
    assert "amix=inputs=2:duration=longest:dropout_transition=0:normalize=0" in fc
    # PNG overlay 烧录
    assert "overlay=0:0:format=auto" in fc
    assert "-loop" in cmd


async def test_audio_guard_remix_with_bgm(monkeypatch, tmp_path):
    """音频 < 视频 85% → 带 BGM 重混一次并落 audio_guard=retried。"""
    import backend.pipeline.producers.media as m

    raw, narr, out = tmp_path / "raw.mp4", tmp_path / "narr.mp3", tmp_path / "final.mp4"
    raw.write_bytes(b"raw")
    narr.write_bytes(b"narr")

    captured: list[list[str]] = []
    audio_values = iter([3.0, 5.0])

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b""

    monkeypatch.setattr(m, "_run_cmd", fake_run)
    async def _pd(p):
        return 5.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad2(p):
        return 5.0 if str(p).endswith("raw.mp4") else next(audio_values)

    monkeypatch.setattr(m, "probe_audio_duration", _pad2)
    async def _sfa2(f):
        return False
    monkeypatch.setattr(m, "subtitles_filter_available", _sfa2)
    monkeypatch.setattr(m, "_find_bgm", lambda: tmp_path / "bgm.mp3")

    result = await m.compose_video(raw, narr, None, out, narr_start=0.0, narr_dur=4.0)

    assert len(captured) == 2
    assert result["quality"]["audio_guard"] == "retried"
    assert "-stream_loop" in captured[1]


async def test_muted_no_narration_drops_audio(monkeypatch, tmp_path):
    """静音模块无旁白：-an 无音轨、不再触发音频守卫。"""
    import backend.pipeline.producers.media as m

    raw, out = tmp_path / "raw.mp4", tmp_path / "final.mp4"
    raw.write_bytes(b"raw")

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b""

    monkeypatch.setattr(m, "_run_cmd", fake_run)
    async def _pd(p):
        return 5.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad3(p):
        return 1.0
    monkeypatch.setattr(m, "probe_audio_duration", _pad3)

    result = await m.compose_video(raw, None, None, out, muted=True)

    assert len(captured) == 1
    assert "-an" in captured[0]
    assert result["quality"]["audio_guard"] == "ok"


async def test_anullsrc_silence_when_no_original_audio(monkeypatch, tmp_path):
    """无原声无旁白：生成整片静音轨。"""
    import backend.pipeline.producers.media as m

    raw, out = tmp_path / "raw.mp4", tmp_path / "final.mp4"
    raw.write_bytes(b"raw")

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b""

    monkeypatch.setattr(m, "_run_cmd", fake_run)
    async def _pd(p):
        return 5.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad4(p):
        return 0.0
    monkeypatch.setattr(m, "probe_audio_duration", _pad4)

    await m.compose_video(raw, None, None, out)

    fc = " ".join(captured[0])
    assert "anullsrc=channel_layout=stereo:sample_rate=44100" in fc
    assert "amix" not in fc
    assert "anull[aout]" in fc


async def test_libass_burn_in(monkeypatch, tmp_path):
    """libass 可用：ASS 烧录路径（burn=ass）。"""
    import backend.pipeline.producers.media as m

    raw, srt, out = tmp_path / "raw.mp4", tmp_path / "subs.srt", tmp_path / "final.mp4"
    raw.write_bytes(b"raw")
    _write_srt(srt)

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b""

    monkeypatch.setattr(m, "_run_cmd", fake_run)
    async def _pd(p):
        return 5.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad5(p):
        return 5.0
    monkeypatch.setattr(m, "probe_audio_duration", _pad5)
    async def _sfa5(f):
        return True
    monkeypatch.setattr(m, "subtitles_filter_available", _sfa5)

    result = await m.compose_video(raw, None, srt, out)

    assert result["quality"]["burn"] == "ass"
    assert "subtitles=" in " ".join(captured[0])
    assert "-loop" not in captured[0]


async def test_pick_voice_uses_tags(monkeypatch, tmp_path):
    """v0.9 修复验证：tags 参与内容匹配（此前调用方恒传 None）。"""
    from backend.pipeline.producers.tts_voice import pick_voice

    voice, reason = pick_voice(
        title="", script="", subreddit="", tags=["科技股 大盘 下跌"],
        configured="auto",
    )
    assert reason == "auto:tech/rational→male"

    voice, reason = pick_voice(
        title="", script="", subreddit="damnthatsinteresting",
        tags=[], configured="auto",
    )
    assert reason == "auto:mixed"


async def test_bilibili_dtime_min_hours_bump(monkeypatch, tmp_path):
    """v0.9 对齐 ensure_bilibili_dtime：scheduled_at 距提交不足 4h → 顺延。"""
    import backend.pipeline.producers.media as m
    from backend.pipeline.publishers.router import BilibiliPublisher

    data_dir = tmp_path / "data"
    (data_dir / "core").mkdir(parents=True)
    (data_dir / "core" / "cookies.json").write_text("{}")
    video = tmp_path / "final.mp4"
    video.write_bytes(b"x")

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b"ok BV1xx411c7mD uploaded"

    monkeypatch.setattr(m, "_run_cmd", fake_run)

    ctx = SimpleNamespace(
        settings=SimpleNamespace(
            data_dir=data_dir, pipeline_bili_dtime_min_hours=4,
        ),
        log=lambda s: None,
    )
    too_soon = datetime.now(UTC) + timedelta(hours=1)
    item = SimpleNamespace(
        video_path=str(video), title="t", script_json={}, source_url="https://x",
        subreddit="r", item_type="video_raw", scheduled_at=too_soon, cover_path="",
    )

    result = await BilibiliPublisher().publish(ctx, item)

    dtime_args = [
        captured[0][i + 1] for i, a in enumerate(captured[0]) if a == "--dtime"
    ]
    assert len(dtime_args) == 1
    bumped_ts = int(dtime_args[0])
    # 顺延目标 ≈ now + 4h5m（内部 now 早于断言 now，容差 60s）
    lower = (datetime.now(UTC) + timedelta(hours=4, minutes=5) - timedelta(seconds=60)).timestamp()
    upper = (datetime.now(UTC) + timedelta(hours=4, minutes=5) + timedelta(seconds=60)).timestamp()
    assert lower <= bumped_ts <= upper
    assert result["dtime_bumped_to"] == bumped_ts


async def test_bilibili_dtime_ok_when_far_enough(monkeypatch, tmp_path):
    """scheduled_at 满足 4h+5m 门槛 → 原样使用、不回写标记。"""
    import backend.pipeline.producers.media as m
    from backend.pipeline.publishers.router import BilibiliPublisher

    data_dir = tmp_path / "data"
    (data_dir / "core").mkdir(parents=True)
    (data_dir / "core" / "cookies.json").write_text("{}")
    video = tmp_path / "final.mp4"
    video.write_bytes(b"x")

    captured: list[list[str]] = []

    async def fake_run(cmd, **kw):
        captured.append(cmd)
        return b"ok BV1xx411c7mD uploaded"

    monkeypatch.setattr(m, "_run_cmd", fake_run)

    ctx = SimpleNamespace(
        settings=SimpleNamespace(data_dir=data_dir, pipeline_bili_dtime_min_hours=4),
        log=lambda s: None,
    )
    far_enough = datetime.now(UTC) + timedelta(hours=6)
    item = SimpleNamespace(
        video_path=str(video), title="t", script_json={}, source_url="https://x",
        subreddit="r", item_type="video_raw", scheduled_at=far_enough, cover_path="",
    )

    result = await BilibiliPublisher().publish(ctx, item)

    assert "--dtime" in captured[0]
    assert "dtime_bumped_to" not in result