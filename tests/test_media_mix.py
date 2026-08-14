"""v0.9 对齐原项目 edit.py 的合成核心单测：
音频混流（时间窗口 duck / apad 防塌缩 / amix normalize=0 / anullsrc /
85% 音频时长守卫）与字幕烧录三级降级（libass → PNG overlay → 无字幕）。

所有 ffmpeg/ffprobe 调用以模块级函数 monkeypatch 捕获命令字符串断言，
不依赖本机 ffmpeg 与 libass。
"""

from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest


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


async def test_asr_translate_false_keeps_original(monkeypatch, tmp_path):
    """v0.10 字幕数据源 = 视频原声：translate=False（仅字幕）→ 转写原文直录
    字幕，不调 LLM 翻译、不清洗标点。"""
    import backend.pipeline.producers.media as m

    asr_srt = tmp_path / "asr.srt"
    asr_srt.write_text(
        "1\n00:00:00,000 --> 00:00:01,000\nHello, world!\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nHow are you?\n",
        encoding="utf-8",
    )
    calls: list[str] = []

    async def fake_transcribe(path, out):
        out.write_text(asr_srt.read_text(encoding="utf-8"), encoding="utf-8")
        return out

    async def fake_has_audio(*a, **k):
        return True

    class FakeAI:
        async def chat_messages(self, messages, **kw):
            calls.append("chat")
            return '{"segments": ["你好"]}'

    monkeypatch.setattr(m, "probe_has_audio", fake_has_audio)
    monkeypatch.setattr("backend.pipeline.producers.asr.transcribe", fake_transcribe)

    got = await m._asr_subtitles(FakeAI(), Path("x.mp4"), tmp_path, translate=False)
    assert got is not None
    srt, full = got
    assert calls == []
    assert full == "Hello, world! How are you?"
    cues = m.parse_srt_cues(Path(srt))
    assert cues[0][2] == "Hello, world!"


async def test_asr_skip_translation_when_already_zh(monkeypatch, tmp_path):
    """v0.10 原声已是目标语言（中文 + zh 目标）→ 跳过 LLM 翻译直接入字幕。"""
    import backend.pipeline.producers.media as m

    asr_srt = tmp_path / "asr.srt"
    asr_srt.write_text(
        "1\n00:00:00,000 --> 00:00:01,000\n他蹲下来了 哭声停了\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\n孩子不哭了\n",
        encoding="utf-8",
    )
    calls: list[str] = []

    async def fake_transcribe(path, out):
        out.write_text(asr_srt.read_text(encoding="utf-8"), encoding="utf-8")
        return out

    async def fake_has_audio(*a, **k):
        return True

    class FakeAI:
        async def chat_messages(self, messages, **kw):
            calls.append("chat")
            return '{"segments": ["x"]}'

    monkeypatch.setattr(m, "probe_has_audio", fake_has_audio)
    monkeypatch.setattr("backend.pipeline.producers.asr.transcribe", fake_transcribe)

    got = await m._asr_subtitles(FakeAI(), Path("x.mp4"), tmp_path, target_lang="zh-CN")
    assert got is not None
    srt, full = got
    assert calls == []
    assert full == "他蹲下来了 哭声停了 孩子不哭了"


async def test_produce_prefers_asr_for_all_subtitle_modes(monkeypatch, tmp_path):
    """v0.10 语义修正：配音模式 + 字幕也优先原声（此前仅 translate 且不配音）。

    voice + subtitle 组合 → 字幕数据源 = ASR 原声（source=asr），
    不再基于简介派生的旁白文案。
    """
    import backend.pipeline.producers.media as m

    raw = tmp_path / "raw.mp4"
    raw.write_bytes(b"raw")
    out_dir = tmp_path / "out"
    out_dir.mkdir(exist_ok=True)

    asr_seen: list[dict] = []

    async def fake_asr(ai, raw_path, directory, **kw):
        asr_seen.append(kw)
        srt = directory / "subs.srt"
        srt.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\n他蹲下来了\n", encoding="utf-8"
        )
        return srt, "他蹲下来了"

    async def fake_probe(p):
        return 10.0

    async def fake_compose(*a, **kw):
        out = a[3]
        out.write_bytes(b"v")
        return {"path": str(out)}

    async def fake_cover(*a):
        return {"path": "/x/cover.jpg"}

    monkeypatch.setattr(m, "_asr_subtitles", fake_asr)
    monkeypatch.setattr(m, "probe_duration", fake_probe)
    monkeypatch.setattr(m, "compose_video", fake_compose)
    monkeypatch.setattr(m, "generate_cover", fake_cover)
    from backend.pipeline import phash as phash_mod

    async def fake_phash(p):
        return "abc"

    monkeypatch.setattr(phash_mod, "compute_phash", fake_phash)

    async def fake_tts(*a, **k):
        return None  # TTS 失败降级 subs-only，不阻塞字幕断言

    monkeypatch.setattr(m, "synthesize_tts", fake_tts)

    class Files:
        def resolve(self, p):
            return Path(p)

        def output_root(self):
            return out_dir

    class FakeAI:
        async def title_and_tags(self, **kw):
            from backend.ai.types import TitleResult
            return TitleResult(title="x", tags=[], description="")

        async def chat_messages(self, messages, **kw):
            return "旁白"

    from backend.models.item import Item

    item = Item(
        status="queued", source="reddit", source_id="asr-1",
        title="t", raw_path=str(raw), output_dir="asr-slug",
        produce_options={"voice": True, "subtitle": True},
    )
    artifacts = await m.produce_item(
        FakeAI(), Files(), item,
        existing_script={"mode": "script", "narration": "Watch this."},
    )

    assert asr_seen, "voice+subtitle 也应尝试 ASR 原声字幕"
    assert artifacts["subtitle"]["source"] == "asr"
    assert artifacts["script"]["subtitle_zh"] == "他蹲下来了"

# ---------- v0.11 内容源 = 视频原声（转写先行，逻辑链重构） ----------

@pytest.mark.asyncio
async def test_generate_script_content_source() -> None:
    """v0.11：generate_script 以视频转写文本为主内容源（content_source=
    transcript）；无转写（<20 字）回退标题+简介（content_source=metadata）。"""
    import backend.pipeline.producers.media as m

    class _Item:
        title = "TITLE STRING"
        subreddit = "space"

    seen: list[tuple[str, str]] = []

    class _FakeAI:
        async def script(self, *, content, title="", max_words=90, task_id=None):
            seen.append((content, title))
            return "A clear narration about the clip."

    item = _Item()
    got = await m.generate_script(
        _FakeAI(), item,
        content="The astronaut said the engine is fine and we are going home.",
    )
    assert got["content_source"] == "transcript"
    assert seen[0][0].startswith("The astronaut said")

    got2 = await m.generate_script(_FakeAI(), item, content="")
    assert got2["content_source"] == "metadata"
    assert item.title in seen[1][0]


@pytest.mark.asyncio
async def test_produce_item_transcript_first(monkeypatch, tmp_path) -> None:
    """v0.11 逻辑链重构：生产先转写视频原声——
    1. 旁白基于转写文本生成（不是标题/简介）
    2. 脚本与字幕共用一次转写（不重复转写）
    3. 转写产物（asr.srt）落盘，字幕 = 转写原文（source=asr）
    """
    import backend.pipeline.producers.asr as asr_mod
    import backend.pipeline.producers.media as m

    raw = tmp_path / "raw.mp4"
    raw.write_bytes(b"fake-raw-bytes")

    class Item:
        raw_path = str(raw)
        output_dir = "v011-transcript"
        produce_options = {
            "voice": False, "subtitle": True,
            "translate": False, "passthrough": False,
        }
        title = "TITLE STRING"
        subreddit = "space"
        author = "a"

    class Files:
        def resolve(self, p):
            return p

        def output_root(self):
            return tmp_path / "out"

    transcribe_calls: list[Path] = []

    async def fake_transcribe(media_path, out_srt):
        transcribe_calls.append(Path(media_path))
        out_srt.write_text(
            "1\n00:00:00,000 --> 00:00:03,000\n"
            "I built this bridge with my own hands.\n\n"
            "2\n00:00:03,500 --> 00:00:06,000\n"
            "Nobody believed it would hold.\n\n",
            encoding="utf-8",
        )
        return out_srt

    seen_content: list[str] = []

    class _FakeAI:
        async def script(self, *, content, title="", max_words=90, task_id=None):
            seen_content.append(content)
            return "A man built a bridge with his own hands."

        async def title_and_tags(self, **kw):
            from backend.ai.types import TitleResult

            return TitleResult(title="x", tags=[], description="")

    monkeypatch.setattr(asr_mod, "transcribe", fake_transcribe)
    async def _pha(p):
        return True

    monkeypatch.setattr(m, "probe_has_audio", _pha)
    async def _pd(p):
        return 20.0

    monkeypatch.setattr(m, "probe_duration", _pd)
    async def _pad(p):
        return 20.0

    monkeypatch.setattr(m, "probe_audio_duration", _pad)
    async def fake_compose(*a, **kw):
        return {"path": str(a[3])}

    monkeypatch.setattr(m, "compose_video", fake_compose)
    async def fake_cover(*a):
        return {"path": "/x/cover.jpg"}

    monkeypatch.setattr(m, "generate_cover", fake_cover)
    from backend.pipeline import phash as phash_mod

    async def fake_phash(p):
        return "abc"

    monkeypatch.setattr(phash_mod, "compute_phash", fake_phash)

    artifacts = await m.produce_item(_FakeAI(), Files(), Item())

    # 1. 旁白内容源 = 视频转写（非标题简介）
    assert seen_content and seen_content[0].startswith("I built this bridge")
    assert artifacts["script"]["content_source"] == "transcript"
    # 2. 只转写一次（脚本与字幕共用预转写结果）
    assert len(transcribe_calls) == 1
    # 3. 转写产物落盘 + 字幕 = 转写原文
    assert str(artifacts["transcript"]["path"]).endswith("asr.srt")
    sub = artifacts["subtitle"]
    assert sub["source"] == "asr"
    cues = m.parse_srt_cues(Path(sub["path"]))
    assert cues[0][2] == "I built this bridge with my own hands."


# ---------- v0.11.1 ASR 词级时间轴（说话者节奏断句，专业对齐） ----------

def _w(start, end, text):
    return (start, end, text)


def test_words_to_cues_speech_pause_alignment() -> None:
    """v0.11.1：词级时间戳保留——长停顿（1.2s）按说话者节奏断句，
    时间戳即原声真实位置（不复排铺满）。"""
    from backend.pipeline.producers.asr import _words_to_cues

    words = [
        _w(0.0, 0.2, "I"), _w(0.2, 0.5, "built"), _w(0.5, 0.9, "this"),
        _w(0.9, 1.4, "bridge."),
        _w(2.6, 2.9, "Nobody"), _w(2.9, 3.4, "believed"),
        _w(3.4, 3.8, "it"), _w(3.8, 4.3, "would"), _w(4.3, 4.8, "hold."),
    ]
    cues = _words_to_cues(words)
    assert cues == [
        (0.0, 1.4, "I built this bridge."),
        (2.6, 4.8, "Nobody believed it would hold."),
    ]


def test_words_to_cues_max_length_hard_split() -> None:
    """v0.11.1：无标点无停顿的长语流按长度硬截断（英文 11 词 / 中文 22 字）。"""
    from backend.pipeline.producers.asr import _words_to_cues

    en = [
        _w(i * 0.2, i * 0.2 + 0.2, w)
        for i, w in enumerate(
            "one two three four five six seven eight nine ten eleven twelve thirteen".split()
        )
    ]
    cues = _words_to_cues(en)
    assert len(cues) == 2
    assert len(cues[0][2].split()) == 11
    assert len(cues[1][2].split()) == 2

    zh_words = [_w(i * 0.1, i * 0.1 + 0.1, ch) for i, ch in enumerate("一二三四五六七八九十" * 3)]
    zh_cues = _words_to_cues(zh_words)
    assert len(zh_cues) == 2
    assert len(zh_cues[0][2]) == 22
    assert len(zh_cues[1][2]) == 8


def test_words_to_cues_merge_short_fragments() -> None:
    """v0.11.1：<0.35s 的碎片并入相邻 cue（首条并入下一条）。"""
    from backend.pipeline.producers.asr import _words_to_cues

    words = [
        _w(0.0, 0.1, "Oh,"), _w(1.0, 1.2, "this"), _w(1.2, 1.6, "works."),
        _w(3.0, 3.1, "Great"),
    ]
    cues = _words_to_cues(words)
    assert cues[0][0] == 1.0 and cues[0][2].startswith("Oh, this")  # 0.1s 碎片并入
    assert cues[-1][0] == 3.0 and cues[-1][2] == "Great"  # 长停顿后的碎片保持独立


def test_words_to_cues_drops_invalid_timestamps() -> None:
    """v0.11.1：NaN/倒置时间戳的词不进入 cue。"""
    from backend.pipeline.producers.asr import _words_to_cues

    words = [_w(0.0, 0.5, "Safe"), _w(0.8, 0.2, "bad"), _w(1.0, 1.5, "text.")]
    cues = _words_to_cues(words)
    assert cues and "bad" not in " ".join(c[2] for c in cues)


@pytest.mark.asyncio
async def test_transcribe_with_whisper_preserves_alignments(monkeypatch, tmp_path) -> None:
    """v0.11.1：whisper 通道用词级时间戳直写 SRT——cue 时间 = 原声真实位置
    （此前整段重排会丢失对齐）。word_timestamps=True + vad_filter=True 传入。"""
    import backend.pipeline.producers.asr as asr_mod

    class _Word:
        def __init__(self, start, end, word):
            self.start, self.end, self.word = start, end, word

    class _Seg:
        def __init__(self, words):
            self.words = words

    kwargs_seen: dict = {}

    async def fake_get_model():
        class _Model:
            def transcribe(self, path, language=None, **kw):
                kwargs_seen.update(kw)
                return (
                    [
                        _Seg([_Word(1.0, 1.3, " Hello"), _Word(1.3, 1.7, " world.")]),
                        _Seg([_Word(3.2, 3.5, " Good"), _Word(3.5, 4.0, " bye.")]),
                    ],
                    {"language": "en"},
                )

        return _Model()

    monkeypatch.setattr(asr_mod, "_get_whisper", fake_get_model)
    out = tmp_path / "asr.srt"
    got = await asr_mod.transcribe_with_whisper(Path("x.mp3"), out)
    assert got is not None
    assert kwargs_seen.get("word_timestamps") is True
    assert kwargs_seen.get("vad_filter") is True
    from backend.pipeline.producers.media import parse_srt_cues

    cues = parse_srt_cues(out)
    assert cues == [
        (1.0, 1.7, "Hello world."),
        (3.2, 4.0, "Good bye."),
    ]  # 时间戳 = 词级真实位置


# ---------- 文字故事产线（v0.11.7 情感频道第二阶段） ----------


@pytest.mark.asyncio
async def test_produce_story_item_artifacts(tmp_path, monkeypatch) -> None:
    """text_only 帖 → 中文故事旁白 + TTS + 渐变背景 + 字幕 + 封面。

    验证分支调度（produce_item 对 text_only 走故事产线）与产物完整性；
    TTS/合成 mock，PIL 背景与 SRT/ASS 走真实实现。
    """
    from pathlib import Path

    from backend.pipeline.producers import media as m

    out_dir = tmp_path / "out"
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    raw = raw_dir / "raw.mp4"
    raw.write_bytes(b"x")

    class FakeAI:
        async def script(self, *, content: str, title: str = "", max_words: int = 90,
                         task_id: str | None = None, story: bool = False) -> str:
            assert story is True, "故事产线必须走 story prompt"
            return "结婚十年，他第一次在她面前哭了。那天晚上他们聊到天亮，把所有误会都说开了。"
        async def title_and_tags(self, **kw):
            from backend.ai.types import TitleResult
            return TitleResult(title="标题", tags=["情感"], description="")

    class Files:
        def resolve(self, p):
            return Path(p)

        def output_root(self):
            return out_dir

    class FakeItem:
        item_type = "text_only"
        id = "story-1"
        title = "他第一次在她面前哭了"
        subreddit = "relationship_advice"
        selftext = "正文" * 100
        output_dir = "story-slug"
        produce_options = {}
        source_id = "story-1"
        author = "u1"
        source_url = "https://www.reddit.com/comments/story1/"
        script_json = None

    tts_seen: dict = {}

    async def fake_tts(ai, text, out_path, *, voice=None):
        tts_seen["text"] = text
        tts_seen["voice"] = voice
        out_path.write_bytes(b"audio")
        return {"path": str(out_path), "bytes": 5}

    async def fake_probe_audio(p):
        return 9.0

    async def fake_compose(bg, audio, ass, out, *, duration):
        out.write_bytes(b"video")
        return {"burn": "ass", "mode": "story"}

    monkeypatch.setattr(m, "synthesize_tts", fake_tts)
    monkeypatch.setattr(m, "probe_audio_duration", fake_probe_audio)
    monkeypatch.setattr(m, "_compose_story_video", fake_compose)

    artifacts = await m.produce_item(FakeAI(), Files(), FakeItem())
    assert artifacts["script"]["mode"] == "story"
    assert artifacts["script"]["content_source"] == "selftext"
    assert tts_seen["voice"] == "zh-CN-XiaoxiaoNeural", "故事产线固定中文 IP 音色"
    assert artifacts["audio"]["path"].endswith("narration.mp3")
    assert artifacts["subtitle"]["path"].endswith("subs.srt")
    assert artifacts["video"]["path"].endswith("final.mp4")
    assert artifacts["video"]["quality"]["mode"] == "story"
    assert artifacts["cover"]["path"].endswith("cover.jpg")
    assert artifacts["phash"] is None
    # 渐变背景 + 封面真实渲染产物存在
    import asyncio

    assert await asyncio.to_thread(Path(artifacts["video"]["path"]).exists)
    assert await asyncio.to_thread(Path(artifacts["cover"]["path"]).exists)
    subs = await asyncio.to_thread(
        lambda: Path(artifacts["subtitle"]["path"]).read_text(encoding="utf-8")
    )
    assert "结婚十年" in subs
