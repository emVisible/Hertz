"""多素材合集装配（v0.35）——把 N 条已下载素材拼成**一条**成片。

存在理由：发布侧是「一个 item 一次上传」（`publishers/router.py:133-138` 的
biliup 固定单文件），逐条发会撞平台频率限制。合成一条 = 一次上传，
是这条限制下唯一有效的减法。

## 为什么必须先归一（这不是洁癖，是实测踩到的坑）

素材来自 Reddit 采集，实测参数高度不齐：同一批里 360x640 竖屏、640x360 横屏、
270x480、352x640、1513x929 25fps 混在一起。而 `concat` demuxer 的 `-c copy`
**要求所有片段参数完全一致**，否则：

- 参数相近（如 360x640 与 360x636）：侥幸能过；
- 方向不同（360x640 与 640x360）：**不报错、exit=0、正常产出文件**，
  但横屏视频被强行压进 360x640 变成变形画面。

静默产出错误成片比报错危险得多——它会一路走到审核页才被发现。所以本模块
**不做 `-c copy`**，一律「每段归一 → 再拼接」。

## 两段式

1. **归一**：每段独立 scale(decrease) + pad + setsar=1 + fps + format=yuv420p，
   音频 aresample 到 44100/stereo。归一后各段参数严格一致。
2. **拼接**：
   - 全部硬切 → `concat=n=N:v=1:a=1`（单 pass，最快）
   - 含转场 → `xfade` 链 + `acrossfade`，offset 递推见 `_build_xfade_chain`

## 非破坏性契约（对齐 `_prepend_channel_intro`）

任何一步失败（ffmpeg 缺失 / 源缺失 / 参数不可解析 / 命令失败 / 产物校验不过）
都抛 `ProducerError`，由调用方决定退路——**本模块自己不静默降级**，
因为「合集悄悄退化成单条」正是要避免的那种静默失效。
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from backend.library.thumbnails import find_ffmpeg
from backend.pipeline.producers.common import (
    ProducerError,
    _raise_if_cancelled,
    _run_cmd,
)
from backend.pipeline.producers.probe import (
    probe_duration,
    probe_has_audio,
    video_stream_params,
)

logger = logging.getLogger(__name__)

#: 可选转场（xfade transition 名 + 特殊值 cut）。**全部在本机 ffmpeg 实测过**
#: （ffmpeg 9.0.1，逐个跑过产��校验），不写没验过的名字——filter 不存在时
#: ffmpeg 报的是 "No such filter"，而那是在整条产线跑起来之后才炸。
TRANSITIONS: dict[str, str] = {
    "cut": "cut",           # 硬切：不过 xfade，走 concat
    "fade": "fade",         # 交叉溶解——最通用，异构素材之间最稳
    "wipe": "wipeleft",     # 方向擦除
    "dissolve": "dissolve", # 噪点溶解
    "zoomin": "zoomin",     # 缩放推进
}
TRANSITION_CHOICES: tuple[str, ...] = tuple(TRANSITIONS)

#: 默认转场时长（秒）。下限/上限都在 `_clamp_transition` 二次钳制。
DEFAULT_TRANSITION_S = 0.6
MIN_TRANSITION_S = 0.2
MAX_TRANSITION_S = 3.0

#: 默认目标画幅（横屏）。竖屏合集由 `_resolve_target` 按首片朝向改写。
DEFAULT_TARGET = (1280, 720, 30)

#: 归一后每段的音频口径（与 `compose.py` 同源，见 `_audio_chain`）。
_AUDIO_RATE = 44100


def _clamp_transition(seconds: object, *, seg_dur: float) -> float:
    """转场时长钳制——**必须钳**，否则 xfade 的 offset 会变负。

    xfade 要求 transition 发生在前一段结束前 `d` 秒处：offset = 累计 - d。
    任一片段短于 d（片段 3 秒、转场 5 秒）→ offset 为负 → ffmpeg 直接报错。
    上限取「片段时长的一半」，保证转场两端都有素材可淡。

    下限与上限冲突时（片段极短，half < MIN）**下限让位**——此时宁可放行一个
    小于 MIN 的转场，也不能返回 MIN（那会再次超出片段、offset 仍为负）。
    换句话说：安全约束（不超片段）优先于风格约束（不小于 MIN）。
    """
    try:
        value = float(seconds)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = DEFAULT_TRANSITION_S
    value = max(MIN_TRANSITION_S, min(MAX_TRANSITION_S, value))
    hard_cap = max(0.0, seg_dur * 0.5)  # 片段太短时这条比 MIN 更重要
    return max(0.0, min(value, hard_cap))


def _resolve_target(first_params: tuple[int, int, float, bool] | None) -> tuple[int, int, int]:
    """目标画幅 = 默认横屏，按**首片朝向**翻转。

    为什么跟随首片而不是一律横屏：合集的受众看的是整体观感。整批竖屏素材
    强行 pad 成 1280x720 会得到左右两条黑边（9:16 → 16:9），观感比黑边更差。
    首片朝向是作者排第一段时的意图，比全局默认更能代表这条片子。
    """
    width, height, fps = DEFAULT_TARGET
    if first_params is not None and first_params[0] < first_params[1]:
        # 首片是竖的 → 输出竖屏（宽高对调；fps 沿用默认，不继承素材的怪帧率）
        return height, width, fps
    return width, height, fps


def _normal_chain(width: int, height: int, fps: int) -> str:
    """单段归一滤镜链。

    - `force_original_aspect_ratio=decrease` + `pad`：保持比例塞进画布，
      不裁切不拉伸（拉伸就是 `-c copy` 那条路的后果）；
    - `setsar=1`：方形像素，否则不同 SAR 的素材拼完会比例失真；
    - `fps=`：统一帧率，否则 concat 时帧率不同的片段会掉帧/变速。
    """
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
        f"setsar=1,fps={fps},format=yuv420p"
    )


def _audio_chain() -> str:
    """音频归一：统一采样率/声道/采样格式。

    与 `compose.py` 的 aformat 同口径——两处各拼一套会让拼接片在后续合成时
    再被重采样一次（`amix` 要求各轨参数一致，否则塌缩）。
    """
    return (
        f"aresample={_AUDIO_RATE}:async=1,"
        "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
    )


async def _probe_segments(clips: list[dict]) -> list[tuple]:
    """逐段探测：路径存在性 + 时长 + 有无音轨 + 流参数。

    缺失源**立刻抛**而不是跳过——跳过会让「配了 5 段」悄悄变成「拼了 3 段」，
    而条目标题/时长/审核页都以为它是完整的。
    """
    probed: list[tuple] = []
    for index, clip in enumerate(clips):
        path = Path(str(clip["path"]))
        if not await asyncio.to_thread(path.exists):
            raise ProducerError(f"合集第 {index + 1} 段素材缺失：{path.name}")
        duration = await probe_duration(path)
        if duration <= 0:
            raise ProducerError(f"合集第 {index + 1} 段素材时长不可解析：{path.name}")
        has_audio = await probe_has_audio(path)
        probed.append((path, duration, has_audio, await video_stream_params(path)))
    return probed


def _build_concat(
    probed: list[tuple], width: int, height: int, fps: int, *, want_audio: bool
) -> tuple[list[str], str, list[str]]:
    """全硬切路径：concat filter，单 pass。

    concat 要求各段参数一致——这正是 `_normal_chain` 先归一的原因。
    任意片段无音轨时整片静音（`anullsrc` 补一条），不做「有声的 + 静音的」混拼：
    那样会出现一半有声音一半没声音的成片，比全静音更糟。
    """
    inputs: list[str] = []
    chains: list[str] = []
    # 每个片段恰好占**一个** `-i`（下标 = 段号 i）；补静音轨的 anullsrc 是
    # 额外的第 N 个输入，必须用独立计数器记录它的下标。**不能靠 len(inputs)
    # 反推**——`-f lavfi` 会让每次追加多占一个元素，算出来的下标会指向别的流。
    next_input_index = 0
    for i, (path, _dur, has_audio, _params) in enumerate(probed):
        inputs += ["-i", str(path)]
        video_index = next_input_index
        next_input_index += 1
        chains.append(f"[{video_index}:v]{_normal_chain(width, height, fps)}[v{i}]")
        if want_audio:
            if has_audio:
                chains.append(f"[{video_index}:a]{_audio_chain()}[a{i}]")
            else:
                inputs += ["-f", "lavfi", "-i", f"anullsrc=r={_AUDIO_RATE}:cl=stereo"]
                # atrim 必须有——anullsrc 无限流，concat 同样会等不到结束而挂死。
                chains.append(
                    f"[{next_input_index}:a]atrim=0:{probed[i][1]:.3f},"
                    f"asetpts=N/SR/TB,{_audio_chain()}[a{i}]"
                )
                next_input_index += 1
    # concat 的输入标签数量必须与 n=v/a 声明**严格一致**：
    # a=0 时每段只喂 [v{i}]（喂了 [a{i}] 会报 "More input link labels than
    # it has inputs: 4 > 2"）；a=1 时每段喂 [v{i}][a{i}]。
    # concat 的输出**已经是最终流**（v=1:a=1 时同一个 pad 承载音视频），
    # 不要再对它套 anull/copy —— 那样等于拿音频滤镜去接视频 pad，报
    # "Media type mismatch between output pad 0 (video) and anull input (audio)"。
    if want_audio:
        tags = "".join(f"[v{i}][a{i}]" for i in range(len(probed)))
        chains.append(f"{tags}concat=n={len(probed)}:v=1:a=1[vx]")
        return inputs, ";".join(chains), ["-map", "[vx]"]
    tags = "".join(f"[v{i}]" for i in range(len(probed)))
    chains.append(f"{tags}concat=n={len(probed)}:v=1:a=0[vx]")
    return inputs, ";".join(chains), ["-map", "[vx]"]


def _build_xfade_chain(
    probed: list[tuple],
    transitions: list[str],
    durations: list[float],
    width: int,
    height: int,
    fps: int,
    *,
    want_audio: bool,
) -> tuple[list[str], str, list[str]]:
    """含转场路径：xfade 链 + acrossfade。

    **offset 递推**（xfade 的核心语义）：转场发生在「已拼好部分」结束前 d 秒处。

        acc = dur[0]
        for i in 1..n-1:  offset[i] = acc - d[i-1];  acc += dur[i] - d[i-1]

    注意 `acc` 累加的是**净增时长**（扣掉已消耗的转场）——xfade 让转场区段
    两段画面重叠，总时长因此减少。忘了扣这一项，整条片子会越拼越长。

    音频用 acrossfade 对齐同一批 offset/时长，音画才同步。
    """
    n = len(probed)
    inputs: list[str] = []
    chains: list[str] = []
    # 下标分配同 `_build_concat`：片段 i 占第 i 个输入，anullsrc 用独立计数器。
    next_input_index = 0
    for i, (path, _dur, has_audio, _params) in enumerate(probed):
        inputs += ["-i", str(path)]
        video_index = next_input_index
        next_input_index += 1
        chains.append(f"[{video_index}:v]{_normal_chain(width, height, fps)}[v{i}]")
        if want_audio and has_audio:
            chains.append(f"[{video_index}:a]{_audio_chain()}[a{i}]")
        elif want_audio:
            # 无音轨段补静音轨。**必须 atrim 截断**：anullsrc 是无限流，
            # 不截断时 acrossfade/concat 永远等不到输入结束——ffmpeg 不报错、
            # 不退出，产线就此挂死（本仓 P1 调试时实测踩到，30 分钟无输出）。
            # atrim 的终点取该段容器时长，所以补出来的静音长度与画面严格对齐。
            inputs += ["-f", "lavfi", "-i", f"anullsrc=r={_AUDIO_RATE}:cl=stereo"]
            chains.append(
                f"[{next_input_index}:a]atrim=0:{probed[i][1]:.3f},"
                f"asetpts=N/SR/TB,{_audio_chain()}[a{i}]"
            )
            next_input_index += 1

    # 视频：逐段 xfade，输出标签在上一段基础上迭代
    current_v = "v0"
    acc = probed[0][1]
    for i in range(1, n):
        transition = TRANSITIONS.get(transitions[i - 1], "cut")
        d = durations[i - 1]
        if transition == "cut":
            # 硬切在 xfade 链里用 duration=0 的 xfade 表达不了，改用拼接——
            # 这里把当前结果与新段 concat（此时两者参数已一致）
            chains.append(f"[{current_v}][v{i}]concat=n=2:v=1:a=0[x{i}]")
            acc += probed[i][1]
        else:
            offset = max(0.0, acc - d)
            chains.append(
                f"[{current_v}][v{i}]xfade=transition={transition}:"
                f"duration={d:.3f}:offset={offset:.3f}[x{i}]"
            )
            acc = acc + probed[i][1] - d
        current_v = f"x{i}"
    # xfade 的输出就是最终视频流，不需要 copy 中转（copy 是恒等变换，
    # 多加一层只是给 filtergraph 多一个节点，且历史上正是这类多余节点
    # 造成 "Media type mismatch" —— 音频 pad 被接到视频输出上）

    maps: list[str] = ["-map", f"[{current_v}]"]
    if want_audio:
        current_a = "a0"
        for i in range(1, n):
            transition = TRANSITIONS.get(transitions[i - 1], "cut")
            d = durations[i - 1]
            if transition == "cut":
                chains.append(f"[{current_a}][a{i}]concat=n=2:v=0:a=1[y{i}]")
            else:
                chains.append(f"[{current_a}][a{i}]acrossfade=d={d:.3f}:c1=tri:c2=tri[y{i}]")
            current_a = f"y{i}"
        maps += ["-map", f"[{current_a}]"]

    return inputs, ";".join(chains), maps


async def assemble_clips(
    clips: list[dict],
    out_path: Path,
    *,
    timeout_s: int = 1800,
) -> dict:
    """把 N 段素材装配成一条成片。返回产物摘要（不含路径自述，路径在 out_path）。

    `clips` 每项：`{"path": str|Path, "transition": str, "transition_s": float}`。
    第一段的 `transition` 被忽略（没有「入场」可言）。`transition` 缺省 = cut。

    失败一律抛 `ProducerError`——本模块不静默降级（理由见模块 docstring）。
    """
    if len(clips) < 1:
        raise ProducerError("合集至少需要 1 段素材")
    ffmpeg = find_ffmpeg()
    if ffmpeg is None:
        raise ProducerError("ffmpeg not found")

    probed = await _probe_segments(clips)
    width, height, fps = _resolve_target(probed[0][3])
    want_audio = any(has_audio for _p, _d, has_audio, _q in probed)

    transitions: list[str] = []
    durations: list[float] = []
    for i in range(1, len(clips)):
        raw_t = str(clips[i].get("transition") or "cut")
        transitions.append(raw_t if raw_t in TRANSITIONS else "cut")
        # 钳制要看**相邻两段**的时长，取较小者的半数才安全
        prev_dur = probed[i - 1][1]
        cur_dur = probed[i][1]
        durations.append(
            _clamp_transition(clips[i].get("transition_s"), seg_dur=min(prev_dur, cur_dur))
        )

    _raise_if_cancelled()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    has_transition = any(t != "cut" for t in transitions)
    if has_transition:
        inputs, filter_complex, maps = _build_xfade_chain(
            probed, transitions, durations, width, height, fps, want_audio=want_audio
        )
    else:
        inputs, filter_complex, maps = _build_concat(
            probed, width, height, fps, want_audio=want_audio
        )

    cmd = [str(ffmpeg), "-y", *inputs, "-filter_complex", filter_complex, *maps]
    if want_audio:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    else:
        cmd += ["-an"]
    cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", str(out_path)]

    await _run_cmd(cmd, timeout_s=timeout_s)

    # 产物校验：ffmpeg 偶发「exit=0 但没写出来」，0 字节文件照样 exit=0
    ok = await asyncio.to_thread(out_path.exists) and (
        await asyncio.to_thread(out_path.stat)
    ).st_size >= 1024
    if not ok:
        raise ProducerError("合集合成未产出有效文件")
    total = await probe_duration(out_path)
    if total <= 0:
        raise ProducerError("合集成片时长不可解析")

    return {
        "clips": len(probed),
        "duration_s": round(total, 3),
        "width": width,
        "height": height,
        "fps": fps,
        "audio": want_audio,
        "transitions": transitions,
        "transition_durations": [round(d, 3) for d in durations],
    }
