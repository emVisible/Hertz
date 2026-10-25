"""字幕工具链（v0.22.x B 系解体第一刀，自 media.py 行段整体迁出）。

职责单一：SRT/ASS 文本处理与时间轴——清洗、分句、beat 配平、
script_to_srt 生成、parse/write 往返、srt_to_ass 转换、逐条本地翻译。
不含：字体/PIL 渲染（compose 域）、ASR 转写、音频处理。

依赖约束：仅 config settings 与 translate_engine——禁止回引 media
（保持单向依赖，media 经模块属性兼容旧引用面）。
"""

import logging
import re
from pathlib import Path

from backend.config import settings
from backend.infrastructure.deps import font_file
from backend.models import script_keys as sk
from backend.pipeline.producers import translate_engine
from backend.pipeline.producers.resolution import target_resolution

logger = logging.getLogger(__name__)

# 句首标点剥离（翻译清洗与英分句共用，v0.8.9）
_LOCALIZE_LEAD_PUNCT = re.compile(
    r"^[\s，,、。.!?！？；;:：'\"“”‘’（）()…—]+"
)

_FONT_NAMES = {
    "latin": "LXGW WenKai", "fallback": "Noto Sans CJK SC",
}

def subtitle_font_family() -> str:
    """ASS Fontname：字体文件存在 → LXGW WenKai；否则 Noto 兜底。"""
    if font_file() is not None:
        return _FONT_NAMES["latin"]
    return _FONT_NAMES["fallback"]

_ZH_PUNCT_RE = re.compile(
    r"[。！？!?；;…‥，,、：:·•"
    r"“”\"'‘’「」『』（）\(\)【】\[\]《》〈〉<>"
    r"～~﹣－—–‐\-_/\\|@#$%^&*+=`]"
)
_SENT_SPLIT_RE = re.compile(r"[。！？!?；;…]+")


def clean_zh_subtitle_text(text: str) -> str:
    """去全部标点；保留句子边界为单空格（原项目 clean_zh_subtitle_text 移植）。"""
    raw = (text or "").strip()
    if not raw:
        return ""
    if _SENT_SPLIT_RE.search(raw):
        cleaned: list[str] = []
        for part in _SENT_SPLIT_RE.split(raw):
            chunk = _ZH_PUNCT_RE.sub("", part)
            chunk = re.sub(r"\s+", "", chunk).strip()
            if chunk:
                cleaned.append(chunk)
        return " ".join(cleaned)
    chunk = _ZH_PUNCT_RE.sub("", raw)
    return re.sub(r"\s+", " ", chunk).strip()


def _split_zh_sentences(text: str) -> list[str]:
    """中文字幕断句（v0.8.9，对齐原项目 _split_zh_sentences）：
    清洗后按空格分段，每段 ≤22 字；超长按 18 字硬折行（无标点可拆）。"""
    cleaned = clean_zh_subtitle_text(text)
    if not cleaned:
        return []
    out: list[str] = []
    for part in [p for p in cleaned.split() if p]:
        if len(part) <= 22:
            out.append(part)
            continue
        for i in range(0, len(part), 18):
            piece = part[i : i + 18]
            if piece:
                out.append(piece)
    return out


# 非中文 cue 行内词数上限（v0.11.3：译文已去标点，按词数硬折行）


_EN_LINE_WORDS = 8


def _split_en_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    out: list[str] = []
    for part in parts:
        part = _LOCALIZE_LEAD_PUNCT.sub("", part).strip()
        if not part:
            continue
        words = part.split()
        # 无标点长句（v0.11.3 译文已去标点）：按词数硬折行，保证单行可读
        if len(words) <= _EN_LINE_WORDS:
            out.append(part)
            continue
        for i in range(0, len(words), _EN_LINE_WORDS):
            chunk = " ".join(words[i : i + _EN_LINE_WORDS])
            if chunk:
                out.append(chunk)
    return out


def _en_beat_weights(en_sentences: list[str]) -> list[float]:
    weights = [float(max(1, len(s.split()))) for s in en_sentences]
    return weights or [1.0]


def _join_cue_parts(parts: list[str]) -> str:
    joined = "".join(parts)
    if any("\u4e00" <= ch <= "\u9fff" for ch in joined):
        return joined
    return " ".join(parts)


def _fit_cues_to_beats(cues: list[str], n_beats: int) -> list[str]:
    """合并/拆分 cue 使数量与英文句数一致（1:1 时间线对齐，原项目移植）。"""
    n = max(1, int(n_beats))
    parts = [c.strip() for c in cues if c and c.strip()]
    if not parts:
        return [" "] * n
    if len(parts) == n:
        return parts
    if len(parts) > n:
        sizes = [max(1, len(p)) for p in parts]
        total = float(sum(sizes))
        target = total / n
        out: list[str] = []
        bucket: list[str] = []
        acc = 0.0
        for p, sz in zip(parts, sizes, strict=False):
            bucket.append(p)
            acc += sz
            if len(out) < n - 1 and acc >= target:
                out.append(_join_cue_parts(bucket))
                bucket = []
                acc = 0.0
        if bucket:
            out.append(_join_cue_parts(bucket))
        while len(out) < n:
            out.append(out[-1] if out else " ")
        return out[:n]
    out = list(parts)
    guard = 0
    while len(out) < n and guard < 64:
        guard += 1
        idx = max(range(len(out)), key=lambda i: len(out[i]))
        text = out[idx]
        if len(text) < 4:
            out.append(text)
            continue
        mid = max(1, len(text) // 2)
        out[idx : idx + 1] = [text[:mid], text[mid:]]
    while len(out) < n:
        out.append(out[-1] if out else " ")
    return out[:n]


def _allocate_slots(
    weights: list[float], total_dur: float, start_offset: float
) -> list[tuple[float, float]]:
    """绝对 [start, end) 槽位，总和精确等于 total_dur（无漂移，原项目移植）。"""
    wsum = sum(weights) or 1.0
    origin = max(0.0, float(start_offset or 0.0))
    span = max(0.5, float(total_dur))
    cursor = origin
    slots: list[tuple[float, float]] = []
    for i, w in enumerate(weights):
        if i == len(weights) - 1:
            end = origin + span
        else:
            end = cursor + span * (w / wsum)
        if end - cursor < 0.45 and i < len(weights) - 1:
            end = min(origin + span, cursor + 0.45)
        slots.append((cursor, end))
        cursor = end
    return slots


def script_to_srt(
    text: str,
    duration: float,
    out_path: Path,
    start_offset: float = 0.0,
    *,
    align_script: str | None = None,
) -> Path:
    """SRT：按句长加权分配时间（v0.3.0，参考原项目 _allocate_slots——
    长句多占时间，短句不硬撑；加旁白起始偏移），替代朴素均分。

    duration = 音频/时间轴实际时长（不含 start_offset——结尾 = offset + 时长，
    原项目语义）；voice 模式调用方传旁白音频实际时长（字幕跟声音同步）。

    v0.8.9 对齐原项目 subtitle.py：
    - 中文断句 _split_zh_sentences（≤22 字 + 18 字硬折行）
    - align_script：中文 cue 1:1 映射到英文 TTS beats（词数加权时间线，
      中文字幕与旁白同拍）；无 duration 时按每字估时（zh 0.18s / en 0.055s）
    """
    offset = max(0.0, float(start_offset or 0.0))
    timing_dur = float(duration) if duration and duration > 0.5 else 0.0
    is_zh = any("\u4e00" <= ch <= "\u9fff" for ch in (text or ""))

    en_align = (align_script or "").strip() if timing_dur > 0 else ""
    if en_align:
        en_beats = _split_en_sentences(en_align) or [en_align]
        zh_cues = _split_zh_sentences(text) if is_zh else [
            s for s in _split_en_sentences(text)
        ]
        if not zh_cues:
            zh_cues = [text.strip()[:80] or " "]
        cues = _fit_cues_to_beats(zh_cues, len(en_beats))
        weights = _en_beat_weights(en_beats)
        slots = _allocate_slots(weights, timing_dur, offset)
        return _write_srt(out_path, zip(cues, slots, strict=True))

    if is_zh:
        sentences = _split_zh_sentences(text)
        weights = [float(max(1, len(s))) for s in sentences]
    else:
        sentences = _split_en_sentences(text)
        weights = _en_beat_weights(sentences)
    if not sentences:
        sentences = [text.strip()[:80] or " "]
        weights = [1.0]

    if timing_dur > 0:
        slots = _allocate_slots(weights, timing_dur, offset)
        return _write_srt(out_path, zip(sentences, slots, strict=True))

    # 无音频长度：回退每字估时（zh 0.18s / en 0.055s，原项目同参）
    spc = 0.18 if is_zh else 0.055
    pairs: list[tuple[str, tuple[float, float]]] = []
    cursor = offset
    for sent in sentences:
        dur = max(1.0, min(5.5, len(sent) * spc))
        pairs.append((sent, (cursor, cursor + dur)))
        cursor += dur
    return _write_srt(out_path, pairs)


def _write_srt(out_path: Path, cues) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for i, (sent, (start, end)) in enumerate(cues, start=1):
        if end <= start:
            end = start + 0.4
        lines.append(str(i))
        lines.append(f"{_fmt_ts(start)} --> {_fmt_ts(end)}")
        lines.append(sent)
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


# —— ASS 预折行（2026-10-25「字幕堆叠」）——
# libass 对**无空格的中文不折行**：实测 ffmpeg 的 subtitles 滤镜在
# WrapStyle 0/1/2 三种下都只在空格处找断点；而 clean_zh_subtitle_text 摘掉
# 全部标点、只在句间留单空格——于是每个句子块强占一行、块内再无断点，块宽
# 超过画幅就整行冲出两端，多个句子块在底部叠成一摞（一条 cue 实拍 3 行、
# 两端被裁，f22.5 取证）。断行只能在生成 ASS 时自己做：按像素预算插硬断行。
_ASS_MAX_LINES = 4  # 超长截断口径，与 compose 的 PNG 通道 _wrap_lines[:4] 对齐


def _char_width(ch: str, font_size: int) -> int:
    """单字符像素宽估算：全角（>U+00FF）按 1em，ASCII 按 0.6em。

    估宽而不是量字体：ASS 路径不该引入 PIL 依赖（那是 PNG 降级通道的事）。
    CJK 字形 advance 在正文字体里精确等于 1em；拉丁数字真实约 0.55em，取
    0.6em 偏保守——估宽只会偏大，行提前断，不会溢出到边距外。
    """
    if ord(ch) > 0xFF:
        return font_size
    return max(1, font_size * 3 // 5)


def _wrap_ass_text(text: str, font_size: int, usable: int) -> str:
    """按像素预算把一段 ASS 文本折成若干行、用 ``\\N`` 连接。

    - 断点在任意两个「原子」之间：单个全角字符/标点各成原子，ASCII 字母
      数字**连写成整块**（「17歲」的 17、英文单词不从中间劈开）。中文随处
      可断（UAX#14 同此）——这正是 libass 缺的那一步。
    - 空格是天然断点：落在行尾即剥掉（中文不需要、英文视觉无损），在行中
      原样保留（「Hertz 项目」不拆开）。
    - 超过 ``_ASS_MAX_LINES`` 截断并标 `…`：与 PNG 降级通道同口径——超过
      4 行的多是机翻退化墙，尾巴本来就是垃圾，宁可少一截不要满屏字。
    - 输入里已有的硬断行（``\\N`` 或换行）逐段独立折行，空段保留。
    """
    if font_size <= 0 or usable <= 0 or not text:
        return text
    out: list[str] = []

    def emit(line: str) -> None:
        if line.strip():
            out.append(line.strip())

    for part in re.split(r"\\N|\n", text):
        if not part:
            out.append("")
            continue
        atoms: list[str] = []
        run = ""
        for ch in part:
            if ch.isascii() and ch.isalnum():
                run += ch
            else:
                if run:
                    atoms.append(run)
                    run = ""
                atoms.append(ch)
        if run:
            atoms.append(run)

        cur: list[str] = []
        cur_w = 0
        for atom in atoms:
            aw = sum(_char_width(c, font_size) for c in atom)
            if aw > usable:
                if cur:
                    emit("".join(cur))
                    cur, cur_w = [], 0
                # 单个连写块就超预算（罕见：上百位数字）：按预算硬切
                cap = max(1, usable // _char_width(atom[0], font_size))
                chunks = [atom[i : i + cap] for i in range(0, len(atom), cap)]
                out.extend(chunks[:-1])
                atom = chunks[-1]
                aw = sum(_char_width(c, font_size) for c in atom)
            if cur and cur_w + aw > usable:
                emit("".join(cur))
                cur, cur_w = [], 0
            cur.append(atom)
            cur_w += aw
        emit("".join(cur))

    if len(out) > _ASS_MAX_LINES:
        out = out[:_ASS_MAX_LINES]
        if out[-1]:
            out[-1] = out[-1][:-1] + "…"
    return "\\N".join(out)


def srt_to_ass(
    srt_path: Path,
    out_path: Path,
    size: tuple[int, int] | None = None,
) -> Path:
    """SRT → ASS（无淡入淡出）。v0.11.4：两个修复——
    1) Events Format 行补上 Name 字段：旧版缺 Name（9 字段）而 Dialogue
    行为 10 值（含空 Name 槽），当前 ffmpeg 9.0.1 会把第 8 字段后的全部
    内容按逗号 join 进文本 → 每句渲染出前导「，」（用户投诉的句首标点）。
    2) 移除 \\fad 标签：稳定优先（fad 曾伴随此字段错位被误判为元凶，
    一并去掉，字幕硬切）。
    v0.4 B1：样式参数读配置（字号/描边/加粗/对齐），设置页可调。
    v0.11.2：字体 → 霞鹜文楷（免费商用优雅楷体）；底部留白可配
    （pipeline_subtitle_margin_bottom）。pipeline_subtitle_fade_ms 已休眠。

    v0.38：`size` 显式传入成片的真实像素尺寸。PlayRes 是 ASS 的**字幕坐标系**，
    它必须等于视频像素——否则字号与边距按错误坐标系缩放（静默的视觉错误）。
    竖屏合集的视频是 720x1280，若 PlayRes 还写 1280x720，字幕会被整体放大/缩小。
    不传时回落到设置里的成片画幅（横屏场景仍然正确）。

    2026-10-25：长句按像素预算预折行（``\\N``）——libass 不给无空格中文折行，
    不预折就整行冲出两边、多句叠成一摞（见 ``_wrap_ass_text``）；ASS 输入
    直接抛错（回喂 = 0 条 Dialogue 静默擦字幕）。
    """
    entries: list[tuple[int, int, str]] = []
    lines = srt_path.read_text(encoding="utf-8").splitlines()
    head = next((ln.strip().lstrip("\ufeff") for ln in lines if ln.strip()), "")
    if head == "[Script Info]":
        raise ValueError(
            "srt_to_ass 只吃 SRT：输入是 ASS，逐行匹配不到 '-->' 会写出 0 条 "
            "Dialogue（静默擦掉已有字幕）。ASS 直接用，别回喂本函数。"
        )
    i = 0
    while i < len(lines):
        m = re.match(r"(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)", lines[i])
        if m:
            h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
            text = "\\N".join(line.strip() for line in lines[i + 1 : i + 3] if line.strip())
            start_cs = (int(h1) * 3600 + int(m1) * 60 + int(s1)) * 100 + int(ms1) // 10
            end_cs = (int(h2) * 3600 + int(m2) * 60 + int(s2)) * 100 + int(ms2) // 10
            entries.append((start_cs, end_cs, text))
            i += 3
            continue
        i += 1
    font_size = int(getattr(settings, "pipeline_subtitle_font_size", 24))
    outline = int(getattr(settings, "pipeline_subtitle_outline", 1))
    bold = "-1" if getattr(settings, "pipeline_subtitle_bold", False) else "0"
    alignment = int(getattr(settings, "pipeline_subtitle_alignment", 2))
    margin_v = int(getattr(settings, "pipeline_subtitle_margin_bottom", 64))
    family = subtitle_font_family()
    # PlayRes 必须与成片像素尺寸一致（v0.37/v0.38）：ASS 用它定义字幕坐标系，
    # 不一致时字号与边距会按旧坐标系缩放——静默的视觉错误，没有任何日志。
    # 调用方知道真实尺寸时必须显式传入（竖屏合集的视频不是设置里的横屏）。
    w, h = size or target_resolution()[:2]
    header = (
        f"[Script Info]\nScriptType: v4.00+\nPlayResX: {w}\nPlayResY: {h}\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{family},{font_size},&H00FFFFFF,&H00FFFFFF,"
        f"&H66000000,&H32000000,{bold},0,0,0,100,100,0,0,1,{outline},0,"
        f"{alignment},40,40,{margin_v},1\n\n[Events]\n"
        # v0.11.4：必须含 Name——Dialogue 行有 10 个值（含空 Name 槽），
        # Format 缺 Name 时 ffmpeg 9.0.1 会把多余字段拼进文本（前导「，」）
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events = []
    # Style 的 MarginL/MarginR 各 40 → 可用宽度；预折行必须落在这个预算里
    usable = w - 80
    for start_cs, end_cs, text in entries:
        if text:
            text = _wrap_ass_text(text, font_size, usable)
            events.append(
                f"Dialogue: 0,{_fmt_ass_cs(start_cs)},{_fmt_ass_cs(end_cs)},"
                f"Default,,0,0,0,,{text}"
            )
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_path


def _fmt_ass_cs(total_cs: int) -> str:
    h, r = divmod(total_cs, 360000)
    m, r = divmod(r, 6000)
    s, r = divmod(r, 100)
    return f"{h}:{m:02d}:{s:02d}.{r:02d}"


def _fmt_ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt_cues(srt_path: Path) -> list[tuple[float, float, str]]:
    """SRT → [(start_sec, end_sec, text), ...]（v0.8.9，对齐原项目）。"""
    text = srt_path.read_text(encoding="utf-8")
    blocks = re.split(r"\n\s*\n", text.strip())
    cues: list[tuple[float, float, str]] = []
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        timing = lines[1] if "-->" in lines[1] else (lines[0] if "-->" in lines[0] else None)
        if not timing:
            continue
        m = re.match(
            r"(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)",
            timing,
        )
        if not m:
            continue
        sh, sm, ss, sms, eh, em, es, ems = map(int, m.groups())
        start = sh * 3600 + sm * 60 + ss + sms / 1000.0
        end = eh * 3600 + em * 60 + es + ems / 1000.0
        body_lines = lines[2:] if "-->" in lines[1] else lines[1:]
        body = "\n".join(body_lines).strip()
        if body:
            cues.append((start, end, body))
    return cues


def _write_srt_cues(out_path: Path, cues: list[tuple[float, float, str]]) -> Path:
    """写 (start, end, text) cue 列表为 SRT（v0.8.9，对齐原项目 _write_srt）。

    v0.10：标点清洗只对中文本体生效（ASR 英文原文要保留标点与停顿感）——
    clean_zh_subtitle_text 的"去标点"语义前提是目标为中文。

    v0.11.3：句首标点全语言清除 + 纯标点 cue 丢弃——真实视频噪声下
    whisper 偶发独立标点词（“。”/“.” 单独成词），非中文 cue 不再放行；
    中文仍全标点清除。译文路径（任意语言）已在上游全标点清除。
    """
    lines: list[str] = []
    for i, (start, end, text) in enumerate(cues, 1):
        has_zh = any("\u4e00" <= ch <= "\u9fff" for ch in text or "")
        body = clean_zh_subtitle_text(text) if has_zh else (text or "").strip()
        if not has_zh:
            # 只剥句首标点（含 …/—）：原声原文保留内部与句尾标点（v0.10 语义）
            body = _LOCALIZE_LEAD_PUNCT.sub("", body).strip()
        if not body:
            body = " "
        lines.append(str(i))
        lines.append(f"{_fmt_ts(start)} --> {_fmt_ts(end)}")
        lines.append(body)
        lines.append("")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


async def _translate_srt_cues(
    cues: list[tuple[float, float, str]],
    target_lang: str = "zh-CN",
) -> list[tuple[float, float, str]]:
    """逐条本地翻译字幕为 target_lang，保留时间戳（v0.22.x 去 API 化，D-189）。

    Opus-MT 批量推理（ctranslate2 单调用）；失败整批回退原 cue 文本，
    不阻塞产线（与旧 LLM 版降级语义一致）。语言守卫由调用方
    （_asr_subtitles 的 _cues_already_target）承担。
    """

    texts = [t.strip() or " " for _, _, t in cues]
    try:
        # 经模块引用晚绑定：测试可对 translate_engine 打补丁
        translated = await translate_engine.translate_batch_local(texts)
    except Exception as exc:  # noqa: BLE001 — 拿不到译文时回退原文
        logger.warning("subtitle local MT failed — keeping original cues: %s", exc)
        translated = list(texts)
    out: list[tuple[float, float, str]] = []
    for (s, e, orig), zh in zip(cues, translated, strict=True):
        body = clean_zh_subtitle_text(zh) or clean_zh_subtitle_text(orig) or " "
        out.append((s, e, body))
    return out


# ---- PIL 字体/折行工具（v0.22.x 自 media.py 迁出）----

# 字幕字体（v0.11.2）：霞鹜文楷（LXGW WenKai，SIL OFL 1.1 免费商用）优先——
# data/assets/fonts/ 或系统字体目录（libass 经 fontconfig 按字体名匹配）；
# 缺字体回退 PingFang / Noto。优雅楷体，减轻 Noto Bold 的厚重感。
def _subtitle_font(size: int = 40):
    """PNG 烧录字幕字体（原项目 _subtitle_font 移植）：assets 霞鹜文楷优先。"""
    from PIL import ImageFont

    from backend.infrastructure.deps import font_file

    candidates: list[Path] = []
    ff = font_file()
    if ff is not None:
        candidates.append(ff)
    candidates += [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Light.ttc"),
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
        Path("/usr/share/fonts/truetype/wqy/wqy-microhei.ttc"),
    ]
    for path in candidates:
        if path.exists():
            try:
                return ImageFont.truetype(str(path), size=size)
            except OSError:
                continue
    return ImageFont.load_default()


def _wrap_lines(text: str, font, max_width: int, draw) -> list[str]:
    """按像素宽折行（原项目 _wrap_lines 移植）。"""
    lines: list[str] = []
    for para in text.replace("\\N", "\n").splitlines() or [text]:
        current = ""
        for ch in para:
            trial = current + ch
            if draw.textlength(trial, font=font) <= max_width:
                current = trial
            else:
                if current:
                    lines.append(current)
                current = ch
        if current:
            lines.append(current)
    return lines or [text]


# ---------- 字幕缓存（自 media.py 迁入，D-v0.23） ----------

def _subtitle_cache_hit(
    existing_script, narration_text: str, src_lang: str, tgt_lang: str
) -> str | None:
    """字幕翻译缓存判定（v0.22.x）：narration 未变 + 译文已持久化 + 语言方向
    匹配 → 返回缓存译文；否则 None（走原翻译逻辑）。

    非破坏性：existing_script 为 None（打回重制）或键缺失 → None；
    「重新翻译」动作走 engine.retranslate 独立路径，不受此缓存影响。
    """
    if not isinstance(existing_script, dict):
        return None
    if str(existing_script.get(sk.NARRATION) or "").strip() != narration_text.strip():
        return None
    if (existing_script.get(sk.SUB_SOURCE) != src_lang
            or existing_script.get(sk.SUB_TARGET) != tgt_lang):
        return None
    cached = str(existing_script.get(sk.SUBTITLE_ZH) or "").strip()
    return cached or None
