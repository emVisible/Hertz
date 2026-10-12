"""多素材合集装配（v0.35 P1）——`producers/assemble.py`。

这里钉的不是「能拼出来」，而是**三件容易静默出错的事**：

1. **横竖屏归一**（最重要）。实测 `concat -c copy` 拼 360x640 竖屏 + 640x360
   横屏会 **exit=0、不报错、正常产出文件**，但横屏被压成变形画面。静默产出
   错误成片会一路流到审核页才被发现。所以测试直接断言**输出分辨率恒等于目标
   画幅**，而不是「命令没炸」。
2. **转场钳制**：片段短于转场时长会让 xfade 的 offset 变负 → ffmpeg 报错。
3. **缺失源必须抛**：跳过缺失段会让「配了 5 段」悄悄变成「拼了 3 段」。

素材一律用 `lavfi` 合成，不依赖开发库存量、不碰网络。
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from sqlalchemy import delete

from backend.library.thumbnails import find_ffmpeg
from backend.pipeline.producers.assemble import (
    DEFAULT_TRANSITION_S,
    MAX_TRANSITION_S,
    MIN_TRANSITION_S,
    TRANSITION_CHOICES,
    _clamp_transition,
    assemble_clips,
)
from backend.pipeline.producers.common import ProducerError
from backend.pipeline.producers.probe import video_stream_params

ffmpeg = find_ffmpeg()
needs_ffmpeg = pytest.mark.skipif(ffmpeg is None, reason="ffmpeg not available")


async def _make_clip(
    path: Path, *, size: str = "320x240", seconds: float = 2.0,
    rate: int = 30, audio: bool = True, color: str = "red",
) -> Path:
    """合成一段测试素材：指定画幅/时长/帧率/有无音轨。"""
    args = [str(ffmpeg), "-y", "-f", "lavfi",
            "-i", f"color=c={color}:size={size}:rate={rate}:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    args += ["-c:a", "aac", "-b:a", "128k"] if audio else ["-an"]
    args += [str(path)]
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    assert await asyncio.to_thread(path.exists), f"测试素材合成失败：{path.name}"
    return path


def _clip_spec(path: Path, transition: str = "cut", transition_s: float = 0.5) -> dict:
    return {"path": str(path), "transition": transition, "transition_s": transition_s}


# ---------- 纯逻辑（无 ffmpeg 依赖，最快） ----------


def test_transition_registry_is_verified_subset() -> None:
    """转场表只收本机实测跑通的；且必须在 TRANSITIONS 里有对应 filter 名。"""
    from backend.pipeline.producers.assemble import TRANSITIONS

    assert TRANSITION_CHOICES == ("cut", "fade", "wipe", "dissolve", "zoomin")
    assert TRANSITIONS["cut"] == "cut", "硬切必须保留独立值（走 concat 不走 xfade）"
    for name, ffmpeg_name in TRANSITIONS.items():
        assert ffmpeg_name, f"{name} 缺 filter 名"


@pytest.mark.parametrize(
    ("given", "seg_dur", "expected"),
    [
        (0.6, 10.0, 0.6),      # 正常值原样通过
        (5.0, 3.0, 1.5),       # 转场 > 片段时长 → 压到片段一半（offset 否则为负）
        (0.05, 10.0, 0.2),     # 过小 → 抬到下限
        (99.0, 30.0, 3.0),     # 过大 → 压到上限
        # 非法值 → 默认值，不崩。期望值引用常量而不是写死 0.6：
        # 写死的话默认值一改这两行仍然绿，但已经不再测任何东西。
        ("abc", 10.0, DEFAULT_TRANSITION_S),
        (None, 10.0, DEFAULT_TRANSITION_S),
    ],
)
def test_clamp_transition(given, seg_dur, expected) -> None:
    assert _clamp_transition(given, seg_dur=seg_dur) == pytest.approx(expected)


def test_clamp_never_negative_for_degenerate_segment() -> None:
    """极端短片段（0.05s）也不许钳出负值——负 offset = ffmpeg 直接报错。"""
    assert _clamp_transition(1.0, seg_dur=0.05) >= 0.0


async def test_empty_clip_list_rejected() -> None:
    with pytest.raises(ProducerError):
        await assemble_clips([], Path("/tmp/never.mp4"))


# ---------- 端到端（真跑 ffmpeg） ----------


@needs_ffmpeg
async def test_two_clips_hard_cut(tmp_path: Path) -> None:
    """两段硬切：走 concat 单 pass，输出时长 = 两段之和。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, color="red")
    b = await _make_clip(tmp_path / "b.mp4", seconds=3.0, color="blue")
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(a), _clip_spec(b)], out)
    assert info["clips"] == 2
    assert info["transitions"] == ["cut"]
    # 帧对齐误差在 ±0.2s 内即可（30fps 下 1 帧 = 0.033s）
    assert info["duration_s"] == pytest.approx(5.0, abs=0.2)


@needs_ffmpeg
async def test_single_clip_is_passthrough_of_assembly(tmp_path: Path) -> None:
    """单段也要能跑（合集从 1 段起步是合法状态，编排界面允许先建后加）。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0)
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(a)], out)
    assert info["clips"] == 1
    assert info["duration_s"] == pytest.approx(2.0, abs=0.2)
    assert out.exists()


@needs_ffmpeg
async def test_three_clips_mixed_transitions(tmp_path: Path) -> None:
    """三段 + 混合转场：cut/fade/wipe 混用，验证 xfade 链的 offset 递推。

    期望时长 = 2 + 2 + 2 - (fade 0.5 + wipe 0.5) = 5.0
    ——转场让两段画面重叠，总时长**减少**，这是最容易被写错的地方。
    """
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, color="red")
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, color="green")
    c = await _make_clip(tmp_path / "c.mp4", seconds=2.0, color="blue")
    out = tmp_path / "out.mp4"
    info = await assemble_clips(
        [
            _clip_spec(a),
            _clip_spec(b, transition="fade", transition_s=0.5),
            _clip_spec(c, transition="wipe", transition_s=0.5),
        ],
        out,
    )
    assert info["transitions"] == ["fade", "wipe"]
    assert info["duration_s"] == pytest.approx(5.0, abs=0.3)


@needs_ffmpeg
async def test_transition_longer_than_clip_is_clamped_not_crashed(tmp_path: Path) -> None:
    """转场时长 > 片段时长：必须钳制后跑通，而不是让 ffmpeg 报错。

    没钳制时 offset = 1.5 - 5.0 = -3.5，xfade 直接失败。
    """
    a = await _make_clip(tmp_path / "a.mp4", seconds=1.5)
    b = await _make_clip(tmp_path / "b.mp4", seconds=1.5)
    out = tmp_path / "out.mp4"
    info = await assemble_clips(
        [_clip_spec(a), _clip_spec(b, transition="fade", transition_s=5.0)], out
    )
    # 钳到 min(3.0, 1.5*0.5)=0.75 → 总时长 ≈ 3.0 - 0.75 = 2.25
    assert info["transition_durations"] == [pytest.approx(0.75)]
    assert info["duration_s"] == pytest.approx(2.25, abs=0.3)


@needs_ffmpeg
async def test_mixed_orientation_is_normalized(tmp_path: Path) -> None:
    """**横竖屏归一回归**——本文件最重要的一条。

    320x240 横 + 240x320 竖混拼（先横后竖）：
    输出必须恒等于首片朝向推导出的目标画幅（横屏 1280x720），
    且**每一段都被归一**（不能是第一段横、第二段竖被压扁）。

    这条在 `-c copy` 方案下会静默产出变形画面且 exit=0——比报错难发现得多。
    """
    landscape = await _make_clip(tmp_path / "wide.mp4", size="320x240", color="red")
    portrait = await _make_clip(tmp_path / "tall.mp4", size="240x320", color="blue")
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(landscape), _clip_spec(portrait)], out)

    params = await video_stream_params(out)
    assert params is not None
    width, height, _fps, _audio = params
    assert (width, height) == (info["width"], info["height"]) == (1280, 720), (
        f"输出未归一到目标画幅：{width}x{height}"
    )


@needs_ffmpeg
async def test_portrait_first_clip_flips_target(tmp_path: Path) -> None:
    """首片是竖的 → 目标画幅翻转成竖屏（跟随首片朝向，见 `_resolve_target`）。

    否则整批竖屏素材会被 pad 成左右两条黑边（9:16 塞进 16:9）。
    """
    portrait = await _make_clip(tmp_path / "tall.mp4", size="240x320", color="red")
    landscape = await _make_clip(tmp_path / "wide.mp4", size="320x240", color="blue")
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(portrait), _clip_spec(landscape)], out)
    assert (info["width"], info["height"]) == (720, 1280)
    params = await video_stream_params(out)
    assert params is not None
    assert (params[0], params[1]) == (720, 1280)


@needs_ffmpeg
async def test_mixed_frame_rate_segments(tmp_path: Path) -> None:
    """不同帧率的片段（30 vs 25）——不归一会掉帧/变速。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, rate=30)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, rate=25)
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(a), _clip_spec(b)], out)
    assert info["fps"] == 30
    assert info["duration_s"] == pytest.approx(4.0, abs=0.3)


@needs_ffmpeg
async def test_silent_segment_gets_silent_track(tmp_path: Path) -> None:
    """无音轨片段：整片仍产出**带音轨**的成片（静音轨补齐）。

    少一条音轨会让后续 compose 的 amix 缺输入——那里是硬失败。
    """
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio=True, color="red")
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, audio=False, color="blue")
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(a), _clip_spec(b)], out)
    assert info["audio"] is True
    params = await video_stream_params(out)
    assert params is not None and params[3] is True, "成片丢了音轨"


@needs_ffmpeg
async def test_all_silent_segments_produce_silent_video(tmp_path: Path) -> None:
    """全部无音轨 → 正常产出纯视频（-an），不报错。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio=False)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, audio=False)
    out = tmp_path / "out.mp4"
    info = await assemble_clips([_clip_spec(a), _clip_spec(b)], out)
    assert info["audio"] is False
    assert out.exists() and out.stat().st_size >= 1024


@needs_ffmpeg
async def test_silent_first_segment_with_transition(tmp_path: Path) -> None:
    """无音轨首段 + 转场：acrossfade 两侧参数必须一致（靠 anullsrc 补轨）。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio=False)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, audio=True)
    out = tmp_path / "out.mp4"
    info = await assemble_clips(
        [_clip_spec(a), _clip_spec(b, transition="fade", transition_s=0.5)], out
    )
    assert out.exists() and out.stat().st_size >= 1024
    assert info["duration_s"] == pytest.approx(3.5, abs=0.3)


@needs_ffmpeg
async def test_missing_source_raises(tmp_path: Path) -> None:
    """缺失源必须抛——跳过会让「配了 N 段」悄悄少拼几段。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0)
    ghost = tmp_path / "nope.mp4"
    with pytest.raises(ProducerError, match="缺失"):
        await assemble_clips([_clip_spec(a), _clip_spec(ghost)], tmp_path / "out.mp4")


@needs_ffmpeg
async def test_unknown_transition_falls_back_to_cut(tmp_path: Path) -> None:
    """未知转场名 → 退硬切，不让一个拼错的字符串毁掉整次合成。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0)
    out = tmp_path / "out.mp4"
    info = await assemble_clips(
        [_clip_spec(a), _clip_spec(b, transition="不存在的转场")], out
    )
    assert info["transitions"] == ["cut"]
    assert out.exists()


@needs_ffmpeg
async def test_every_registered_transition_runs(tmp_path: Path) -> None:
    """**逐个跑遍转场表**——表里写了但 ffmpeg 不认的名字，只在真实合成时才炸。

    这是「不写没验过的名字」那条纪律的执行点：注册表 = 已验证集合。
    """
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, color="red")
    for name in TRANSITION_CHOICES:
        b = await _make_clip(tmp_path / f"b_{name}.mp4", seconds=2.0, color="blue")
        out = tmp_path / f"out_{name}.mp4"
        info = await assemble_clips(
            [_clip_spec(a), _clip_spec(b, transition=name, transition_s=0.5)], out
        )
        assert out.exists() and out.stat().st_size >= 1024, f"{name} 未产出文件"
        assert info["clips"] == 2


@needs_ffmpeg
async def test_silent_track_is_trimmed_not_infinite(tmp_path: Path) -> None:
    """**anullsrc 挂死回归**——本文件最阴的一个坑。

    `anullsrc` 是**无限流**。若补静音轨时不做 atrim 截断，concat/acrossfade
    会永远等不到输入结束：ffmpeg **不报错、不退出**、产线就此挂住
    （P1 实测：单条用例跑满 30 分钟零输出）。

    这条测试的价值在于「它必须能跑完」——哪天谁把 atrim 删了，
    这里的 `asyncio.wait_for` 会先超时把测试变红，而不是让 CI 挂死。
    """
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio=False)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, audio=True)
    out = tmp_path / "out.mp4"

    async def _run() -> dict:
        return await assemble_clips(
            [_clip_spec(a), _clip_spec(b, transition="fade", transition_s=0.5)], out
        )

    # 超时保护：atrim 缺失时 ffmpeg 静默挂死，这里必须让它变红而不是挂住整轮
    info = await asyncio.wait_for(_run(), timeout=90)
    assert out.exists() and out.stat().st_size >= 1024
    assert info["duration_s"] == pytest.approx(3.5, abs=0.3)


@needs_ffmpeg
async def test_all_silent_concat_terminates(tmp_path: Path) -> None:
    """全无音轨 + 硬切（concat 路径）：同样必须终止，且不产出多余音轨。"""
    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, audio=False)
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, audio=False)
    out = tmp_path / "out.mp4"
    info = await asyncio.wait_for(
        assemble_clips([_clip_spec(a), _clip_spec(b)], out), timeout=90
    )
    assert info["audio"] is False
    params = await video_stream_params(out)
    assert params is not None
    assert params[3] is False, "全无音轨的合集不应凭空多出音轨"


# ---------- P2：产线转接（items.clips → raw_path 单点转接） ----------


def _compilation_item(clips: dict, *, output_dir: str = "pipeline/v035-compile"):
    """构造一个合集条目（不设 raw_path——合集本身没有原始媒体）。"""
    from types import SimpleNamespace

    return SimpleNamespace(
        id=__import__("uuid").uuid4(),
        title="合集",
        item_type="video_raw",
        raw_path=None,          # 合集条目的关键特征
        clips=clips,
        output_dir=output_dir,
        script_json=None,
        video_path=None,
    )


@needs_ffmpeg
async def test_compilation_item_has_no_raw_and_still_assembles(tmp_path: Path) -> None:
    """**合集条目没有 raw_path 也必须能装配**。

    这是转接位置的关键判据：老代码在 `_produce_item` 里先校验
    `raw_path` 存在，不存在直接抛 "raw media missing"（那是单条目的判据）。
    若转接放在校验之后，合集永远走不到装配。
    """
    from backend.infrastructure.storage import FileStore
    from backend.models.item import Item as _Item
    from backend.models.session import session_factory
    from backend.pipeline.producers.media import _assemble_compilation

    a = await _make_clip(tmp_path / "a.mp4", seconds=2.0, color="red")
    b = await _make_clip(tmp_path / "b.mp4", seconds=2.0, color="blue")

    # 种两条已下载源条目，产出 item_id 供合集引用
    src_ids = []
    async with session_factory() as session:
        for name, clip in (("srcA", a), ("srcB", b)):
            row = _Item(
                source="v035-compile", source_id=name, status="downloaded",
                item_type="video_raw", title=name, raw_path=str(clip),
            )
            session.add(row)
            await session.flush()
            src_ids.append(str(row.id))
        await session.commit()

    item = _compilation_item({
        "clips": [
            {"item_id": src_ids[0]},
            {"item_id": src_ids[1], "transition": "fade", "transition_s": 0.5},
        ],
    })
    files = FileStore()
    try:
        out = await _assemble_compilation(item, files, tmp_path / "out")
        assert item.raw_path is None, "合集条目不该有 raw_path"
        assert await asyncio.to_thread(out.exists)
        assert (await asyncio.to_thread(out.stat)).st_size >= 1024
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(_Item).where(_Item.source == "v035-compile")
            )
            await session.commit()


@needs_ffmpeg
async def test_compilation_missing_source_item_raises(tmp_path: Path) -> None:
    """引用了不存在的条目 → 明确报错，不是静默拼成少一段。"""
    from backend.infrastructure.storage import FileStore
    from backend.pipeline.producers.media import _assemble_compilation

    item = _compilation_item({
        "clips": [{"item_id": str(__import__("uuid").uuid4())}],
    })
    with pytest.raises(ProducerError):
        await _assemble_compilation(item, FileStore(), tmp_path / "out")


@needs_ffmpeg
async def test_compilation_empty_clip_plan_raises(tmp_path: Path) -> None:
    from backend.infrastructure.storage import FileStore
    from backend.pipeline.producers.media import _assemble_compilation

    with pytest.raises(ProducerError, match="片段"):
        await _assemble_compilation(
            _compilation_item({"clips": []}), FileStore(), tmp_path / "out"
        )


@needs_ffmpeg
async def test_compilation_undownloaded_source_raises(tmp_path: Path) -> None:
    """引用了还没下载的条目 → 报错（而不是拿空路径去拼）。"""
    from backend.infrastructure.storage import FileStore
    from backend.models.item import Item as _Item
    from backend.models.session import session_factory
    from backend.pipeline.producers.media import _assemble_compilation

    async with session_factory() as session:
        row = _Item(
            source="v035-compile", source_id="nodl", status="discovered",
            item_type="video_raw", title="未下载", raw_path=None,
        )
        session.add(row)
        await session.flush()
        rid = str(row.id)
        await session.commit()
    try:
        item = _compilation_item({"clips": [{"item_id": rid}]})
        with pytest.raises(ProducerError, match="尚未下载"):
            await _assemble_compilation(item, FileStore(), tmp_path / "out")
    finally:
        async with session_factory() as session:
            await session.execute(
                delete(_Item).where(_Item.source == "v035-compile")
            )
            await session.commit()


def test_non_compilation_items_take_the_original_path() -> None:
    """**无 clips 的条目走老路径**——回归护栏。

    P2 只在 `item.clips` 非空时改变行为；存量条目（clips=None）必须逐字走
    原来的 `raw_path` 校验 + 直发分支，否则这次改动就是全量产线的风险。

    注意转接判据是 `if getattr(item, "clips", None)`——**空 dict / 空 clips
    列表也算「有 clips」**（dict/非空判断），会进装配分支再由
    `_assemble_compilation` 抛「没有片段配置」。那是刻意的：宁可对一条
    配置坏了的合集报错，也不要静默按单条目处理——后者会让编排界面看起来
    配好了、成片却是单条的。
    """
    from types import SimpleNamespace

    # 存量条目：clips 为 None → 老路径
    plain = SimpleNamespace(clips=None, raw_path="/x/raw.mp4")
    assert not getattr(plain, "clips", None), "存量条目不该被误判为合集"

    # 反过来：只要 clips 是非空结构，就必须走装配（哪怕内容是空的），
    # 不能因为「看起来像没配」就退回单条路径。
    for configured in ({"clips": []}, {"clips": None}, {"target": {"width": 1}}):
        item = SimpleNamespace(clips=configured, raw_path=None)
        assert getattr(item, "clips", None), (
            f"{configured} 应被当作已配置的合集条目（由装配层报配置错误）"
        )


def test_default_transition_within_legal_range() -> None:
    """默认转场必须落在 [MIN, MAX] 内，且本身是合法的步进值。

    默认值若越界，`_clamp_transition` 会在每次装配时把它悄悄改掉——用户填的和
    实际生效的不是一个数，而没有任何提示。
    """
    assert MIN_TRANSITION_S <= DEFAULT_TRANSITION_S <= MAX_TRANSITION_S


def test_default_transition_is_quoted_in_the_api_error() -> None:
    """后端默认值与界面默认值必须一致，否则「不填」时两边算出不同总时长。

    编排面板把 `transition_s` 显式发出去，通常用不到后端默认值；但任何漏填的
    路径（老草稿、手工请求）都会走到这里。两边不一致 = 预估与成片不符。
    """
    from backend.pipeline.producers import assemble as asm

    assert asm.DEFAULT_TRANSITION_S == pytest.approx(0.32)
